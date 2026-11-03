// Package foldersync watches folders and uploads new files through the tunnel
// — shared foundation for Immich (photos) and Paperless (documents).
//
// Why a cursor of its own instead of "uploaded once, never look again":
// the same file can show up again after a restart (folder scan), and
// Immich/Paperless would create it twice without an identifier. So every file
// gets a stable identifier from relative path + modification time + size
// (pattern of the Android app: deviceAssetId/deviceId). The local cursor
// remembers what has gone through — it advances on success AND on "duplicate",
// so a server-side duplicate is not retried forever.
package foldersync

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Result of an upload attempt.
const (
	ResultUploaded  = iota // newly created
	ResultDuplicate        // server already knows the file
	ResultFailed
)

// Uploader is the service-specific half (Immich or Paperless).
type Uploader interface {
	// Name of the module, e.g. "immich-sync".
	Name() string
	// Accepts decides whether a file is a candidate for this service at all
	// (images vs. documents).
	Accepts(path string) bool
	// Upload uploads exactly one file.
	Upload(ctx context.Context, client *http.Client, path, assetID, deviceID string) (int, error)
}

// Progress reports progress to the UI (SSE `sync.progress`).
type Progress struct {
	Module    string `json:"module"`
	Done      int    `json:"done"`
	Total     int    `json:"total"`
	LastError string `json:"last_error,omitempty"`
}

type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

type Module struct {
	up       Uploader
	folders  []string
	dial     DialFunc
	emit     func(Progress)
	deviceID string
	cursorFn string // path of the cursor file

	mu     sync.Mutex
	seen   map[string]bool
	cancel context.CancelFunc
}

func New(up Uploader, folders []string, dial DialFunc, deviceID, cursorFile string,
	emit func(Progress)) *Module {
	return &Module{
		up: up, folders: folders, dial: dial, emit: emit,
		deviceID: deviceID, cursorFn: cursorFile, seen: map[string]bool{},
	}
}

func (m *Module) ID() string { return m.up.Name() }

// assetID: stable identifier of a file. Deliberately NOT the content hash —
// that would read every file completely in large photo folders. Path+mtime+size
// is enough to recognise "already uploaded", and changes exactly when the file
// really is a different one.
func assetID(root, path string, info os.FileInfo) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = filepath.Base(path)
	}
	h := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d",
		filepath.ToSlash(rel), info.ModTime().UnixNano(), info.Size())))
	return "desktop-" + hex.EncodeToString(h[:])
}

func (m *Module) loadCursor() {
	raw, err := os.ReadFile(m.cursorFn)
	if err != nil {
		return
	}
	var ids []string
	if json.Unmarshal(raw, &ids) == nil {
		m.mu.Lock()
		for _, id := range ids {
			m.seen[id] = true
		}
		m.mu.Unlock()
	}
}

func (m *Module) saveCursor() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.seen))
	for id := range m.seen {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	sort.Strings(ids)
	raw, err := json.Marshal(ids)
	if err != nil {
		return
	}
	tmp := m.cursorFn + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, m.cursorFn)
	}
}

// Start: go through everything once, then check periodically. Deliberately
// polling instead of file events: event APIs behave differently on Windows,
// Linux and network drives, lose events on bulk copies and would have needed
// an extra dependency. One pass every 5 minutes is more than enough for photo
// and scan folders.
func (m *Module) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.cancel = cancel
	m.mu.Unlock()
	defer cancel()

	if len(m.folders) == 0 {
		return fmt.Errorf("keine Ordner konfiguriert")
	}
	m.loadCursor()

	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           func(c context.Context, n, a string) (net.Conn, error) { return m.dial(c, n, a) },
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
		Timeout: 30 * time.Minute, // large videos/scans need room
	}

	for {
		m.runOnce(ctx, client)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Minute):
		}
	}
}

func (m *Module) runOnce(ctx context.Context, client *http.Client) {
	type job struct{ root, path, id string }
	var jobs []job

	for _, root := range m.folders {
		_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
			if err != nil || info == nil || info.IsDir() {
				return nil
			}
			// Skip partially written files (browser downloads, camera transfer):
			// anything younger than 30 s waits for the next pass.
			if time.Since(info.ModTime()) < 30*time.Second {
				return nil
			}
			if !m.up.Accepts(p) {
				return nil
			}
			id := assetID(root, p, info)
			m.mu.Lock()
			known := m.seen[id]
			m.mu.Unlock()
			if !known {
				jobs = append(jobs, job{root, p, id})
			}
			return nil
		})
	}
	if len(jobs) == 0 {
		return
	}
	log.Printf("%s: %d neue Datei(en)", m.up.Name(), len(jobs))

	done, lastErr := 0, ""
	for _, j := range jobs {
		if ctx.Err() != nil {
			return
		}
		res, err := m.up.Upload(ctx, client, j.path, j.id, m.deviceID)
		switch res {
		case ResultUploaded, ResultDuplicate:
			m.mu.Lock()
			m.seen[j.id] = true
			m.mu.Unlock()
			done++
		default:
			if err != nil {
				lastErr = err.Error()
			}
			log.Printf("%s: %s fehlgeschlagen: %v", m.up.Name(), filepath.Base(j.path), err)
		}
		m.emit(Progress{Module: m.up.Name(), Done: done, Total: len(jobs), LastError: lastErr})
	}
	m.saveCursor()
	log.Printf("%s: Durchlauf fertig — %d/%d", m.up.Name(), done, len(jobs))
}

func (m *Module) Stop() {
	m.mu.Lock()
	c := m.cancel
	m.mu.Unlock()
	if c != nil {
		c()
	}
	m.saveCursor()
}

// HasExt is a small helper for the uploaders.
func HasExt(path string, exts ...string) bool {
	e := strings.ToLower(filepath.Ext(path))
	for _, x := range exts {
		if e == x {
			return true
		}
	}
	return false
}

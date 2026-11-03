// Package ntfypush subscribes to ntfy and turns every message into a native
// desktop notification (forwarding: daemon → SSE → Tauri notification).
//
// Unlike the Android app (OkHttp WebSocket) we use the **JSON stream**
// `GET /{topic}/json` — same delivery, but only one http.Client needed, whose
// transport dials through the tsnet tunnel. Fewer dependencies, same semantics
// (including `since` against missed/duplicate messages).
package ntfypush

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Notification is what the UI eventually displays.
type Notification struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	ClickURL string `json:"click_url,omitempty"`
	Priority int    `json:"priority,omitempty"`
}

// Config comes from provisioning (state.Config).
type Config struct {
	Server string // host without scheme, e.g. "push.example.org"
	Topic  string
	Auth   string // "Bearer …"
}

// DialFunc dials through the tunnel (tsnode.Node.Dial).
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Originally only the personal topic was subscribed. Practically only the
// approval service writes there — all system notifications (watchdogs, drift
// alerts, infrastructure) go to `clara` and were therefore never visible in
// the app. ntfy can serve several topics in one subscription (/a,b,c/json).
// 🔴 If ONE read permission is missing, ntfy rejects the WHOLE subscription with
// 403 (measured). Anyone not allowed to read `clara` (family members) would then
// get no notifications at all — so the module permanently falls back to the
// personal topic.
var zusatzTopics = []string{"clara", "clara-alerts"}

type Module struct {
	cfg    Config
	dial   DialFunc
	emit   func(Notification)
	mu     sync.Mutex
	since  string // ntfy cursor: ID of the last seen message
	cancel context.CancelFunc

	nurEigenes bool // true once the multi-topic subscription was rejected with 403

	onAuthStale   func()    // reports "credential no longer valid"
	letzteMeldung time.Time // minimum interval against self-amplification
}

func New(cfg Config, dial DialFunc, emit func(Notification)) *Module {
	return &Module{cfg: cfg, dial: dial, emit: emit, since: "all"}
}

// SetAuthStaleHandler registers the callback for "the credential is no longer valid".
//
// 🔴 The daemon stored its ntfy credential at pairing time and NEVER renewed it.
// ntfy issued tokens with a 72 h lifetime — three days after pairing the server
// answered 401 permanently, and one machine's log filled with thousands of
// "stream ended (ntfy HTTP 401)" lines without anything happening.
// This callback is the start of the healing path.
func (m *Module) SetAuthStaleHandler(f func()) {
	m.mu.Lock()
	m.onAuthStale = f
	m.mu.Unlock()
}

// UpdateAuth installs a fresh credential. The next connection attempt uses it.
//
// 🔑 `nurEigenes` is reset as well: the fallback to the personal topic may also
// stem from the OLD credential no longer being allowed to read the extra topics.
// After a swap the full subscription may be tried again — otherwise the device
// loses the system notifications permanently without anything ever failing.
func (m *Module) UpdateAuth(auth string) {
	m.mu.Lock()
	m.cfg.Auth = auth
	m.nurEigenes = false
	m.mu.Unlock()
}

// topicPfad builds the topic list for the URL. The personal topic always comes
// first; extra topics are dropped once they have been rejected.
func (m *Module) topicPfad() string {
	m.mu.Lock()
	nurEigenes := m.nurEigenes
	m.mu.Unlock()
	if nurEigenes {
		return m.cfg.Topic
	}
	topics := []string{m.cfg.Topic}
	for _, t := range zusatzTopics {
		// Don't duplicate a multi-topic list delivered by the server.
		if !strings.Contains(","+m.cfg.Topic+",", ","+t+",") {
			topics = append(topics, t)
		}
	}
	return strings.Join(topics, ",")
}

func (m *Module) ID() string { return "ntfy-push" }

// meldeZugangUngueltig calls the handler — at most every 10 minutes.
//
// 🔴 The minimum interval is not cosmetic: if the renewal itself fails (session
// expired, app closed), the stream keeps running into its 401. Without a brake
// the device would ask again on every attempt — the same self-amplification
// that has previously exhausted ntfy's subscription limit, because all tailnet
// devices count behind the same SNAT entry.
func (m *Module) meldeZugangUngueltig() {
	m.mu.Lock()
	handler := m.onAuthStale
	if handler == nil || time.Since(m.letzteMeldung) < 10*time.Minute {
		m.mu.Unlock()
		return
	}
	m.letzteMeldung = time.Now()
	m.mu.Unlock()
	log.Printf("ntfy: Zugang gilt nicht mehr (401) — frage einen frischen an")
	go handler()
}

// message = one line of the ntfy JSON stream.
type message struct {
	ID       string `json:"id"`
	Time     int64  `json:"time"`
	Event    string `json:"event"` // message | keepalive | open | poll_request
	Topic    string `json:"topic"`
	Title    string `json:"title"`
	Message  string `json:"message"`
	Click    string `json:"click"`
	Priority int    `json:"priority"`
}

// Start connects and reads until ctx ends. Connection drops are normal (laptop
// lid, Wi-Fi switch) → reconnect with backoff, never give up.
func (m *Module) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.cancel = cancel
	m.mu.Unlock()
	defer cancel()

	if m.cfg.Server == "" || m.cfg.Topic == "" {
		return fmt.Errorf("ntfy nicht konfiguriert (Server/Topic fehlt)")
	}

	client := &http.Client{
		Transport: &http.Transport{
			DialContext:           func(c context.Context, n, a string) (net.Conn, error) { return m.dial(c, n, a) },
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
		},
		// No client timeout: the stream is meant to stay open.
	}

	backoff := 2 * time.Second
	for ctx.Err() == nil {
		err := m.stream(ctx, client)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			log.Printf("ntfy: Stream beendet (%v) — neuer Versuch in %s", err, backoff)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
	return nil
}

func (m *Module) stream(ctx context.Context, client *http.Client) error {
	m.mu.Lock()
	since := m.since
	auth := m.cfg.Auth // under mutex: UpdateAuth writes it from another goroutine
	m.mu.Unlock()

	topics := m.topicPfad()
	url := fmt.Sprintf("https://%s/%s/json?since=%s",
		strings.TrimSuffix(m.cfg.Server, "/"), topics, since)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 401/403 on a multi-topic subscription means: at least one extra topic is not
		// allowed. Fall back to the personal topic permanently — better one's own
		// notifications than none at all.
		if (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) &&
			topics != m.cfg.Topic {
			m.mu.Lock()
			m.nurEigenes = true
			m.mu.Unlock()
			log.Printf("ntfy: %s nicht erlaubt (HTTP %d) — Rueckfall auf %s",
				topics, resp.StatusCode, m.cfg.Topic)
		}
		// 🔑 A 401 on the OWN topic is not a permission problem, it means "the login
		// does not work" — credential expired or revoked (missing permissions would be
		// 403, verified on the server). Only report then; a 401 on the multi-topic
		// subscription already falls back to the own topic above and must not trigger
		// a renewal, otherwise we would swap out an intact credential.
		if resp.StatusCode == http.StatusUnauthorized && topics == m.cfg.Topic {
			m.meldeZugangUngueltig()
		}
		return fmt.Errorf("ntfy HTTP %d", resp.StatusCode)
	}
	log.Printf("ntfy: verbunden mit %s/%s (since=%s)", m.cfg.Server, topics, since)

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg message
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue // skip broken line, keep the stream running
		}
		// ALWAYS advance the cursor (keepalives too), so a reconnect does not
		// redeliver half the history.
		if msg.ID != "" {
			m.mu.Lock()
			m.since = msg.ID
			m.mu.Unlock()
		}
		if msg.Event != "message" {
			continue // open/keepalive/poll_request are of no interest to the UI
		}
		title := msg.Title
		if title == "" {
			title = "ClaraOS"
		}
		m.emit(Notification{
			Title:    title,
			Body:     msg.Message,
			ClickURL: msg.Click,
			Priority: msg.Priority,
		})
	}
	return sc.Err()
}

func (m *Module) Stop() {
	m.mu.Lock()
	c := m.cancel
	m.mu.Unlock()
	if c != nil {
		c()
	}
}

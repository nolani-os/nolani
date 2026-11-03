package foldersync

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// direct: plain dialer for the tests (in production it goes through the tunnel).
func direct(ctx context.Context, network, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, addr)
}

func writeOld(t *testing.T, dir, name string, content []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
	// Bypass the 30 s grace period for half-written files.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestImmichUploadSendetAndroidFelder(t *testing.T) {
	var gotFields map[string]string
	var gotKey, gotFile string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		gotFields = map[string]string{}
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			if part.FileName() != "" {
				gotFile = part.FileName()
				_, _ = io.Copy(io.Discard, part)
				continue
			}
			b, _ := io.ReadAll(part)
			gotFields[part.FormName()] = string(b)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "x", "status": "created"})
	}))
	defer srv.Close()

	dir := t.TempDir()
	p := writeOld(t, dir, "bild.jpg", []byte("jpegdaten"))

	im := &Immich{BaseURL: srv.URL, APIKey: "geheim"}
	res, err := im.Upload(context.Background(), srv.Client(), p, "desktop-abc", "desktop-pc")
	if err != nil || res != ResultUploaded {
		t.Fatalf("res=%d err=%v", res, err)
	}
	if gotKey != "geheim" {
		t.Errorf("x-api-key = %q", gotKey)
	}
	if gotFields["deviceAssetId"] != "desktop-abc" || gotFields["deviceId"] != "desktop-pc" {
		t.Errorf("Dedup-Felder falsch: %v", gotFields)
	}
	if gotFields["fileCreatedAt"] == "" || gotFields["isFavorite"] != "false" {
		t.Errorf("Pflichtfelder fehlen: %v", gotFields)
	}
	if gotFile != "bild.jpg" {
		t.Errorf("Dateiname = %q", gotFile)
	}
}

func TestImmichDuplikatWirdErkannt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "x", "status": "duplicate"})
	}))
	defer srv.Close()
	dir := t.TempDir()
	p := writeOld(t, dir, "bild.jpg", []byte("x"))
	im := &Immich{BaseURL: srv.URL, APIKey: "k"}
	res, err := im.Upload(context.Background(), srv.Client(), p, "id", "dev")
	if err != nil || res != ResultDuplicate {
		t.Fatalf("res=%d err=%v", res, err)
	}
}

func TestPaperlessTokenUndKonflikt(t *testing.T) {
	var auth, field string
	code := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		if part, err := mr.NextPart(); err == nil {
			field = part.FormName()
			_, _ = io.Copy(io.Discard, part)
		}
		w.WriteHeader(code)
	}))
	defer srv.Close()

	dir := t.TempDir()
	p := writeOld(t, dir, "scan.pdf", []byte("%PDF-1.4"))
	pl := &Paperless{BaseURL: srv.URL, Token: "drf123"}

	res, err := pl.Upload(context.Background(), srv.Client(), p, "id", "dev")
	if err != nil || res != ResultUploaded {
		t.Fatalf("res=%d err=%v", res, err)
	}
	if auth != "Token drf123" {
		t.Errorf("Authorization = %q", auth)
	}
	if field != "document" {
		t.Errorf("Feldname = %q", field)
	}

	// 409 = Paperless already knows the document → count as duplicate, otherwise
	// the cursor retries it endlessly.
	code = http.StatusConflict
	res, err = pl.Upload(context.Background(), srv.Client(), p, "id", "dev")
	if err != nil || res != ResultDuplicate {
		t.Fatalf("409: res=%d err=%v", res, err)
	}
}

// zaehlUploader counts how often each file is uploaded.
type zaehlUploader struct {
	mu    sync.Mutex
	calls map[string]int
	fail  bool
}

func (z *zaehlUploader) Name() string          { return "test-sync" }
func (z *zaehlUploader) Accepts(p string) bool { return HasExt(p, ".jpg") }
func (z *zaehlUploader) Upload(_ context.Context, _ *http.Client, path, _, _ string) (int, error) {
	z.mu.Lock()
	defer z.mu.Unlock()
	z.calls[filepath.Base(path)]++
	if z.fail {
		return ResultFailed, io.ErrUnexpectedEOF
	}
	return ResultUploaded, nil
}

func TestCursorVerhindertDoppelteUploads(t *testing.T) {
	dir := t.TempDir()
	writeOld(t, dir, "a.jpg", []byte("a"))
	writeOld(t, dir, "b.jpg", []byte("b"))
	writeOld(t, dir, "egal.txt", []byte("kein Bild"))

	cursor := filepath.Join(t.TempDir(), "cursor.json")
	z := &zaehlUploader{calls: map[string]int{}}
	m := New(z, []string{dir}, direct, "dev", cursor, func(Progress) {})

	m.runOnce(context.Background(), http.DefaultClient)
	m.saveCursor()
	if z.calls["a.jpg"] != 1 || z.calls["b.jpg"] != 1 {
		t.Fatalf("erster Lauf: %v", z.calls)
	}
	if z.calls["egal.txt"] != 0 {
		t.Errorf("Nicht-Bild wurde hochgeladen: %v", z.calls)
	}

	// Second run of the same instance: nothing new.
	m.runOnce(context.Background(), http.DefaultClient)
	if z.calls["a.jpg"] != 1 {
		t.Fatalf("zweiter Lauf hat erneut hochgeladen: %v", z.calls)
	}

	// App restart: the cursor must be read from disk.
	z2 := &zaehlUploader{calls: map[string]int{}}
	m2 := New(z2, []string{dir}, direct, "dev", cursor, func(Progress) {})
	m2.loadCursor()
	m2.runOnce(context.Background(), http.DefaultClient)
	if len(z2.calls) != 0 {
		t.Fatalf("nach Neustart erneut hochgeladen: %v", z2.calls)
	}

	// A changed file gets a new identifier → uploaded again.
	writeOld(t, dir, "a.jpg", []byte("a-geaendert-laenger"))
	m2.runOnce(context.Background(), http.DefaultClient)
	if z2.calls["a.jpg"] != 1 {
		t.Fatalf("geaenderte Datei nicht erneut hochgeladen: %v", z2.calls)
	}
}

func TestFehlerRuecktCursorNichtVor(t *testing.T) {
	dir := t.TempDir()
	writeOld(t, dir, "a.jpg", []byte("a"))
	cursor := filepath.Join(t.TempDir(), "cursor.json")

	z := &zaehlUploader{calls: map[string]int{}, fail: true}
	m := New(z, []string{dir}, direct, "dev", cursor, func(Progress) {})
	m.runOnce(context.Background(), http.DefaultClient)
	m.runOnce(context.Background(), http.DefaultClient)
	if z.calls["a.jpg"] != 2 {
		t.Fatalf("fehlgeschlagene Datei wurde nicht erneut versucht: %v", z.calls)
	}
}

func TestFrischeDateienWartenAufDenNaechstenLauf(t *testing.T) {
	dir := t.TempDir()
	// Without Chtimes: just written → deliberately skipped, so half-copied files
	// are not uploaded.
	if err := os.WriteFile(filepath.Join(dir, "frisch.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	z := &zaehlUploader{calls: map[string]int{}}
	m := New(z, []string{dir}, direct, "dev", filepath.Join(t.TempDir(), "c.json"), func(Progress) {})
	m.runOnce(context.Background(), http.DefaultClient)
	if len(z.calls) != 0 {
		t.Fatalf("frische Datei wurde hochgeladen: %v", z.calls)
	}
}

func TestAssetIDStabilUndPfadabhaengig(t *testing.T) {
	dir := t.TempDir()
	p := writeOld(t, dir, "x.jpg", []byte("abc"))
	info, _ := os.Stat(p)
	a := assetID(dir, p, info)
	b := assetID(dir, p, info)
	if a != b {
		t.Fatal("assetID nicht stabil")
	}
	if !strings.HasPrefix(a, "desktop-") {
		t.Fatalf("Praefix fehlt: %s", a)
	}
	if c := assetID(filepath.Dir(dir), p, info); c == a {
		t.Fatal("assetID haengt nicht am relativen Pfad")
	}
}

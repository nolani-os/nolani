package ntfypush

import (
	"testing"
	"time"
)

// The app's credential expired after 72 h and was never renewed. These tests
// cover the two building blocks of the healing path that can be checked
// without a running tunnel — the full path (401 -> event -> fresh credential)
// is measured on a device.

func TestMeldungNurEinmalProZeitfenster(t *testing.T) {
	m := New(Config{Server: "push.example", Topic: "alice", Auth: "Bearer alt"}, nil, nil)
	rufe := make(chan struct{}, 10)
	m.SetAuthStaleHandler(func() { rufe <- struct{}{} })

	m.meldeZugangUngueltig()
	m.meldeZugangUngueltig()
	m.meldeZugangUngueltig()

	// The handler runs in its own goroutine — give it a moment.
	time.Sleep(100 * time.Millisecond)
	if got := len(rufe); got != 1 {
		t.Fatalf("erwartet genau 1 Meldung im Zeitfenster, bekam %d", got)
	}

	// Window artificially expired -> may report again.
	m.mu.Lock()
	m.letzteMeldung = time.Now().Add(-11 * time.Minute)
	m.mu.Unlock()
	m.meldeZugangUngueltig()
	time.Sleep(100 * time.Millisecond)
	if got := len(rufe); got != 2 {
		t.Fatalf("nach Ablauf des Fensters erwartet 2, bekam %d", got)
	}
}

func TestOhneHandlerKeinAbsturz(t *testing.T) {
	m := New(Config{Server: "push.example", Topic: "alice"}, nil, nil)
	m.meldeZugangUngueltig() // must simply do nothing
}

func TestUpdateAuthSetztZugangUndErlaubtZusatzTopicsWieder(t *testing.T) {
	m := New(Config{Server: "push.example", Topic: "alice", Auth: "Bearer alt"}, nil, nil)

	// State after a rejected multi-topic subscription.
	m.mu.Lock()
	m.nurEigenes = true
	m.mu.Unlock()
	if got := m.topicPfad(); got != "alice" {
		t.Fatalf("im Rueckfall erwartet nur das eigene Topic, bekam %q", got)
	}

	m.UpdateAuth("Bearer neu")

	m.mu.Lock()
	auth := m.cfg.Auth
	m.mu.Unlock()
	if auth != "Bearer neu" {
		t.Fatalf("Zugang nicht uebernommen: %q", auth)
	}
	// 🔑 The fallback must be lifted: it may stem from the OLD credential not being
	// allowed to read the extra topics. If it stayed, the device would lose the
	// system notifications permanently without anything ever failing.
	if got := m.topicPfad(); got != "alice,clara,clara-alerts" {
		t.Fatalf("nach dem Wechsel erwartet volles Abo, bekam %q", got)
	}
}

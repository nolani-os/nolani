package ntfypush

import "testing"

// The multi-topic subscription must never cause a user without read
// permission on `clara` to receive no notifications at all.
func TestTopicPfad(t *testing.T) {
	m := New(Config{Server: "push.example.org", Topic: "alice"}, nil, nil)

	if got := m.topicPfad(); got != "alice,clara,clara-alerts" {
		t.Fatalf("Mehrfach-Abo erwartet, bekam %q", got)
	}

	m.nurEigenes = true
	if got := m.topicPfad(); got != "alice" {
		t.Fatalf("Rueckfall auf das persoenliche Topic erwartet, bekam %q", got)
	}
}

// If the server already delivers a list, nothing may be appended twice.
func TestTopicPfadKeineDoppelung(t *testing.T) {
	m := New(Config{Topic: "bob,clara"}, nil, nil)
	if got := m.topicPfad(); got != "bob,clara,clara-alerts" {
		t.Fatalf("keine Doppelung erwartet, bekam %q", got)
	}
}

//go:build linux

package devicecontrol

import (
	"testing"

	"github.com/godbus/dbus/v5"
)

// These tests need no D-Bus: what is checked is the logic between radio input
// and the UI. Behaviour on a real adapter is measured separately on a laptop.

func TestAPSSIDEntferntSteuerzeichen(t *testing.T) {
	// SSIDs are radio input: anyone in range can choose them freely.
	// Control characters have no business in names that later pass through
	// JSON, Rust and a WebView.
	cases := map[string]string{
		"HomeNet 5G":           "HomeNet 5G",
		"Netz\x00mit\x1bMuell": "NetzmitMuell",
		"\x7f":                 "",
		"Nachbar WLAN":         "Nachbar WLAN",
	}
	for raw, want := range cases {
		props := map[string]dbus.Variant{"Ssid": dbus.MakeVariant([]byte(raw))}
		if got := apSSID(props); got != want {
			t.Errorf("apSSID(%q) = %q, erwartet %q", raw, got, want)
		}
	}
	// A missing field must not end in a panic.
	if got := apSSID(map[string]dbus.Variant{}); got != "" {
		t.Errorf("apSSID(leer) = %q, erwartet \"\"", got)
	}
}

func TestNeuesProfilGehoertDemNutzer(t *testing.T) {
	// Without connection.permissions the profile counts as a system profile and
	// polkit demands admin rights — connecting then fails silently. The test
	// pins exactly this line.
	s, err := nmNewWifiSettings("TestNetz", "geheim123")
	if err != nil {
		t.Fatalf("nmNewWifiSettings: %v", err)
	}
	perms, ok := s["connection"]["permissions"].Value().([]string)
	if !ok || len(perms) != 1 || len(perms[0]) < 6 || perms[0][:5] != "user:" {
		t.Fatalf("permissions fehlen oder haben falsche Form: %#v", s["connection"]["permissions"])
	}
	if _, ok := s["802-11-wireless-security"]; !ok {
		t.Error("mit psk muss ein Sicherheitsabschnitt entstehen")
	}
	ssid, _ := s["802-11-wireless"]["ssid"].Value().([]byte)
	if string(ssid) != "TestNetz" {
		t.Errorf("ssid = %q", ssid)
	}
}

func TestOffenesNetzOhneSicherheitsabschnitt(t *testing.T) {
	s, err := nmNewWifiSettings("Gastnetz", "")
	if err != nil {
		t.Fatalf("nmNewWifiSettings: %v", err)
	}
	if _, ok := s["802-11-wireless-security"]; ok {
		t.Error("ohne psk darf kein Sicherheitsabschnitt entstehen (offenes Netz)")
	}
}

func TestSetDynamicCapBautDieListeNeu(t *testing.T) {
	// State() hands out the cap slice. If setDynamicCap modified it via append,
	// a concurrent reader would see garbage — so the old slice must remain
	// untouched.
	m := &Module{caps: []string{"wifi", "audio"}}
	vorher := m.State().Caps

	m.setDynamicCap("wifi.set", true)
	if len(vorher) != 2 {
		t.Fatalf("alte Slice wurde veraendert: %v", vorher)
	}
	if !m.HasCap("wifi.set") {
		t.Error("wifi.set fehlt nach dem Einschalten")
	}

	m.setDynamicCap("wifi.set", true) // idempotent
	n := 0
	for _, c := range m.State().Caps {
		if c == "wifi.set" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("wifi.set steht %d-mal in der Liste", n)
	}

	m.setDynamicCap("wifi.set", false)
	if m.HasCap("wifi.set") {
		t.Error("wifi.set haette verschwinden muessen (Sitzung nicht mehr aktiv)")
	}
	if !m.HasCap("wifi") || !m.HasCap("audio") {
		t.Error("die uebrigen Caps duerfen dabei nicht verlorengehen")
	}
}

func TestBluetoothConnectPrueftDieAdresse(t *testing.T) {
	// Must fail BEFORE any bus access, otherwise the test runs into D-Bus.
	b := &bluezBT{}
	for _, bad := range []string{"", "AA:BB", "ZZ:ZZ:ZZ:ZZ:ZZ:ZZ", "AA-BB-CC-DD-EE-FF"} {
		if err := b.Connect(bad, false); !IsBadInput(err) {
			t.Errorf("Connect(%q) haette 400 liefern muessen, lieferte %v", bad, err)
		}
	}
}

func TestWifiConnectPruefungenOhneProvider(t *testing.T) {
	// Without a provider (e.g. a machine without radios) 501 must come, never a crash.
	m := &Module{}
	if err := m.WifiConnect("Netz", ""); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
	if _, err := m.SetWifiEnabled(true); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
	if _, err := m.BluetoothDevices(); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
}

func TestWifiConnectPrueftEingaben(t *testing.T) {
	n := &nmWifi{}
	if err := n.Connect("", ""); !IsBadInput(err) {
		t.Errorf("leere ssid muss 400 liefern, lieferte %v", err)
	}
	if err := n.Connect("Netz", "kurz"); !IsBadInput(err) {
		t.Errorf("zu kurzes psk muss 400 liefern, lieferte %v", err)
	}
}

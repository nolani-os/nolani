//go:build linux

package devicecontrol

import (
	"encoding/json"
	"testing"
)

// The fixtures come from REAL pactl 17 output (inside a Selkies container),
// not from the documentation — same rule as for the netsh parsing on
// Windows: measure first, then parse.

const fixtureSinks = `[
 {"index":1,"state":"SUSPENDED","name":"output","description":"Lautsprecher (eingebaut)",
  "mute":false,
  "volume":{"front-left":{"value":40960,"value_percent":"62%","db":"-8.00 dB"},
            "front-right":{"value":45875,"value_percent":"70%","db":"-6.00 dB"}},
  "properties":{"device.description":"output","device.class":"abstract"}},
 {"index":7,"state":"RUNNING","name":"bluez_output.AA_BB","description":"Kopfhoerer",
  "mute":true,
  "volume":{"mono":{"value":65536,"value_percent":"100%","db":"0.00 dB"}},
  "properties":{"device.class":"sound"}}
]`

const fixtureSources = `[
 {"index":2,"name":"output.monitor","description":"Monitor of output","mute":false,
  "volume":{"mono":{"value":65536,"value_percent":"100%"}},
  "properties":{"device.class":"monitor"}},
 {"index":3,"name":"ClaraMic","description":"ClaraOS-Mikrofon","mute":true,
  "volume":{"mono":{"value":32768,"value_percent":"50%"}},
  "properties":{"device.class":"filter"}},
 {"index":4,"name":"alsa_input.pci-0000_00_1f.3","description":"Internes Mikrofon","mute":false,
  "volume":{"front-left":{"value":65536,"value_percent":"100%"}},
  "properties":{}}
]`

func parseFixture(t *testing.T, raw string) []paDevice {
	t.Helper()
	var out []paDevice
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("Fixture nicht lesbar: %v", err)
	}
	return out
}

func TestMonitorQuellenFliegenRaus(t *testing.T) {
	// "Monitor of output" is the recording of the OUTPUT. If it were in the
	// microphone selection, the user would pick their own speaker as the
	// microphone and hear themselves.
	src := parseFixture(t, fixtureSources)
	if !src[0].isMonitor() {
		t.Error("output.monitor haette als Monitor erkannt werden muessen (device.class)")
	}
	if src[1].isMonitor() || src[2].isMonitor() {
		t.Error("echte Aufnahmegeraete duerfen nicht als Monitor gelten")
	}
	// Second detection path: name suffix, in case device.class is missing.
	ohneKlasse := paDevice{Name: "irgendwas.monitor"}
	if !ohneKlasse.isMonitor() {
		t.Error("Namenssuffix .monitor muss auch ohne device.class greifen")
	}
}

func TestLautstaerkeNimmtDenLautestenKanal(t *testing.T) {
	sinks := parseFixture(t, fixtureSinks)
	if got := sinks[0].volumePercent(); got != 70 {
		t.Errorf("volumePercent = %d, erwartet 70 (lauterer der beiden Kanaele)", got)
	}
	if got := sinks[1].volumePercent(); got != 100 {
		t.Errorf("volumePercent (mono) = %d, erwartet 100", got)
	}
	// A broken/missing value must not end in a panic.
	leer := paDevice{Volume: map[string]paVolumeChannel{"x": {ValuePercent: "kaputt"}}}
	if got := leer.volumePercent(); got != 0 {
		t.Errorf("unlesbarer Wert = %d, erwartet 0", got)
	}
}

func TestBeschreibungIstDerAnzeigename(t *testing.T) {
	// The UI shows "Kopfhoerer" (headphones), not "bluez_output.AA_BB".
	sinks := parseFixture(t, fixtureSinks)
	if sinks[1].Description != "Kopfhoerer" {
		t.Errorf("Description = %q", sinks[1].Description)
	}
	if sinks[1].Name != "bluez_output.AA_BB" {
		t.Errorf("Name (stabile Kennung) = %q", sinks[1].Name)
	}
}

func TestSetDefaultPrueftDieArt(t *testing.T) {
	p := &pactlDevices{}
	if err := p.SetDefault("lautsprecher", "output"); !IsBadInput(err) {
		t.Errorf("unbekannte Art muss 400 liefern, lieferte %v", err)
	}
}

func TestOhneProviderKommt501(t *testing.T) {
	m := &Module{}
	if _, err := m.AudioDevices(); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
	if _, err := m.SetDefaultAudioDevice("sink", "x"); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
	muted := true
	if _, err := m.SetMic(&muted, nil); !IsUnsupported(err) {
		t.Errorf("ohne Provider erwartet: unsupported, bekommen: %v", err)
	}
}

func TestSetMicPrueftEingaben(t *testing.T) {
	// Provider present, but empty call or range error.
	m := &Module{mic: &pactlMic{}}
	if _, err := m.SetMic(nil, nil); !IsBadInput(err) {
		t.Errorf("leerer Aufruf muss 400 liefern, lieferte %v", err)
	}
	zuLaut := 101
	if _, err := m.SetMic(nil, &zuLaut); !IsBadInput(err) {
		t.Errorf("volume 101 muss 400 liefern, lieferte %v", err)
	}
}

func TestMicSektionWirdNurBeiAenderungGemeldet(t *testing.T) {
	// stateMicSlot is the diff point: same value = no event, otherwise the
	// 3 s poll floods the bridge with identical messages.
	m := &Module{}
	st := MicState{Muted: true, Volume: 50, Source: "Internes Mikrofon"}
	if !m.stateMicSlot(st) {
		t.Fatal("erster Wert muss als Aenderung gelten")
	}
	if m.stateMicSlot(st) {
		t.Error("unveraenderter Wert darf kein Event ausloesen")
	}
	st.Muted = false
	if !m.stateMicSlot(st) {
		t.Error("geaenderte Stummschaltung muss ein Event ausloesen")
	}
}

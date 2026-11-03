package devicecontrol

import "testing"

// The keys come from a real ConsentStore.
func TestAppDisplayName(t *testing.T) {
	cases := map[string]string{
		`C:#Users#Admin#AppData#Local#Discord#app-1.0.9011#Discord.exe`:      "Discord",
		`C:#Program Files#Mozilla Firefox#firefox.exe`:                       "firefox",
		`C:#Program Files (x86)#StarCraft II#Versions#Base92174#SC2_x64.exe`: "SC2_x64",
		`C:#Windows#System32#WindowsPowerShell#v1.0#powershell.exe`:          "powershell",
		"MSTeams_8wekyb3d8bbwe":                       "MSTeams",
		"Microsoft.WindowsCamera_8wekyb3d8bbwe":       "Microsoft.WindowsCamera",
		"windows.immersivecontrolpanel_cw5n1h2txyewy": "windows.immersivecontrolpanel",
	}
	for key, want := range cases {
		if got := appDisplayName(key); got != want {
			t.Errorf("appDisplayName(%q) = %q, erwartet %q", key, got, want)
		}
	}
}

// 🔑 "SC2_x64.exe" checks that the underscore cut for package names is NOT
// applied to file names — otherwise the game would be called "SC2".
func TestAppDisplayNameSchneidetDateinamenNichtAmUnterstrich(t *testing.T) {
	if got := appDisplayName(`C:#Spiele#SC2_x64.exe`); got != "SC2_x64" {
		t.Errorf("Dateiname am Unterstrich abgeschnitten: %q", got)
	}
}

func TestInUseBrauchtBeideBedingungen(t *testing.T) {
	cases := []struct {
		name  string
		e     privacyEntry
		wantU bool
	}{
		// This is what it looked like during the real measurement.
		{"laeuft gerade", privacyEntry{Key: "a", Start: 133000000000000000, Stop: 0}, true},
		{"beendet", privacyEntry{Key: "a", Start: 133000000000000000, Stop: 133000000000000100}, false},
		// 🔑 Mere permission note without any use ever: start is 0.
		// Anyone checking only `Stop == 0` reports it as active — and the UI claims
		// the microphone is running although nobody is listening.
		{"nie benutzt", privacyEntry{Key: "a", Start: 0, Stop: 0}, false},
	}
	for _, c := range cases {
		if got := c.e.inUse(); got != c.wantU {
			t.Errorf("%s: inUse() = %v, erwartet %v", c.name, got, c.wantU)
		}
	}
}

func TestSummarizeUse(t *testing.T) {
	entries := []privacyEntry{
		{Key: `C:#Program Files#Mozilla Firefox#firefox.exe`, Start: 1, Stop: 2},  // ended
		{Key: `C:#Users#Admin#AppData#Local#Discord#app-1#Discord.exe`, Start: 1}, // running
		{Key: "MSTeams_8wekyb3d8bbwe", Start: 1},                                  // running
		{Key: "Nie_benutzt", Start: 0, Stop: 0},                                   // note
	}
	got := summarizeUse(entries)
	if !got.InUse {
		t.Fatal("InUse muss wahr sein, es greifen zwei Anwendungen zu")
	}
	if len(got.Apps) != 2 {
		t.Fatalf("erwartet 2 Anwendungen, bekam %v", got.Apps)
	}
	// Alphabetical, so the row doesn't jump on every poll.
	if got.Apps[0] != "Discord" || got.Apps[1] != "MSTeams" {
		t.Errorf("Reihenfolge/Namen falsch: %v", got.Apps)
	}
	// The ended application must NOT show up.
	for _, a := range got.Apps {
		if a == "firefox" {
			t.Error("beendete Nutzung wird als aktiv gemeldet")
		}
	}
}

func TestSummarizeUseLeer(t *testing.T) {
	got := summarizeUse([]privacyEntry{{Key: "a", Start: 1, Stop: 2}})
	if got.InUse || len(got.Apps) != 0 {
		t.Errorf("nichts aktiv, trotzdem: %+v", got)
	}
}

// The same application can have several keys (different version folders).
// The name may appear only once.
func TestSummarizeUseEntdoppelt(t *testing.T) {
	entries := []privacyEntry{
		{Key: `C:#Users#Admin#Discord#app-1.0.9011#Discord.exe`, Start: 1},
		{Key: `C:#Users#Admin#Discord#app-1.0.9012#Discord.exe`, Start: 1},
	}
	if got := summarizeUse(entries); len(got.Apps) != 1 {
		t.Errorf("Name doppelt gemeldet: %v", got.Apps)
	}
}

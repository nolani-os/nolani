package devicecontrol

import "testing"

// Fixtures from REAL output of a German Windows 11 (build 26200), including
// the CRLF line endings — not copied from the documentation.
const netshProfilesDE = "\r\n" +
	"Profile auf Schnittstelle WLAN 9:\r\n" +
	"\r\n" +
	"Gruppenrichtlinienprofile (schreibgesch\xfctzt)\r\n" +
	"---------------------------------\r\n" +
	"    <Kein>\r\n" +
	"\r\n" +
	"Benutzerprofile\r\n" +
	"---------------\r\n" +
	"    Profil f\xfcr alle Benutzer : iPhone\r\n" +
	"    Profil f\xfcr alle Benutzer : [TV]Room 425\r\n" +
	"    Profil f\xfcr alle Benutzer : VodafoneMobileWiFi-72A737\r\n" +
	"    Profil f\xfcr alle Benutzer : Example Net 5G\r\n"

// The same output in English — proof that the parsing does not depend on the
// language (exactly where a trap had been suspected).
const netshProfilesEN = "\r\n" +
	"Profiles on interface WLAN 9:\r\n" +
	"\r\n" +
	"Group policy profiles (read only)\r\n" +
	"---------------------------------\r\n" +
	"    <None>\r\n" +
	"\r\n" +
	"User profiles\r\n" +
	"-------------\r\n" +
	"    All User Profile     : iPhone\r\n" +
	"    All User Profile     : Example Net 5G\r\n"

func TestParseKnownProfiles(t *testing.T) {
	for name, raw := range map[string]string{"deutsch": netshProfilesDE, "englisch": netshProfilesEN} {
		got := parseKnownProfiles(raw)
		if !got["Example Net 5G"] {
			t.Errorf("%s: Heimnetz nicht erkannt, gefunden: %v", name, got)
		}
		if !got["iPhone"] {
			t.Errorf("%s: iPhone nicht erkannt", name)
		}
		// Heading, separator line and placeholder must NOT count as a network.
		for _, unerwuenscht := range []string{"", "<Kein>", "<None>", "---------------------------------"} {
			if got[unerwuenscht] {
				t.Errorf("%s: %q faelschlich als Profil gewertet", name, unerwuenscht)
			}
		}
	}
	// 🔑 The heading ends in ':' — it must not yield an empty name, otherwise
	// every network with an empty name counts as known.
	if len(parseKnownProfiles(netshProfilesDE)) != 4 {
		t.Errorf("erwartet 4 Profile, bekam %d", len(parseKnownProfiles(netshProfilesDE)))
	}
}

// SSIDs may themselves contain colons — then the FIRST one counts.
func TestParseKnownProfilesMitDoppelpunktImNamen(t *testing.T) {
	raw := "    Profil f\xfcr alle Benutzer : Netz:mit:Doppelpunkt\r\n"
	got := parseKnownProfiles(raw)
	if !got["Netz:mit:Doppelpunkt"] {
		t.Errorf("Name mit Doppelpunkten abgeschnitten: %v", got)
	}
}

const netshInterfacesVerbunden = "\r\n" +
	"Es ist 1 Schnittstelle auf dem System vorhanden:\r\n" +
	"\r\n" +
	"    Name                   : WLAN 9\r\n" +
	"    Beschreibung           : Intel(R) Wi-Fi 6 AX200 160MHz #5\r\n" +
	"    GUID                   : 505a06d3-5842-41b8-afef-7532a7cceddd\r\n" +
	"    Physische Adresse      : 00:00:5e:00:53:01\r\n" +
	"    Status                 : Verbunden\r\n" +
	"    SSID                   : Example Net 5G\r\n" +
	"    BSSID                  : 3c:a6:2f:11:22:33\r\n" +
	"    Signal                 : 99%\r\n"

const netshInterfacesGetrennt = "\r\n" +
	"    Name                   : WLAN 9\r\n" +
	"    Status                 : getrennt\r\n" +
	"    Funkstatus             : Hardware Aktiviert\r\n"

func TestParseConnectedSSID(t *testing.T) {
	if got := parseConnectedSSID(netshInterfacesVerbunden); got != "Example Net 5G" {
		t.Errorf("verbunden: bekam %q", got)
	}
	// 🔑 Not connected is NOT an error — the section simply stays empty.
	if got := parseConnectedSSID(netshInterfacesGetrennt); got != "" {
		t.Errorf("getrennt: erwartet leer, bekam %q", got)
	}
}

// The BSSID sits directly below the SSID and carries a MAC address with
// colons. Anyone checking only for "contains SSID" shows the user
// "3c:a6:2f:11:22:33" as the network name.
func TestParseConnectedSSIDVerwechseltBSSIDNicht(t *testing.T) {
	nurBssidZuerst := "    BSSID                  : 3c:a6:2f:11:22:33\r\n" +
		"    SSID                   : Heimnetz\r\n"
	if got := parseConnectedSSID(nurBssidZuerst); got != "Heimnetz" {
		t.Errorf("BSSID verwechselt: bekam %q", got)
	}
}

func TestMergeByStrongest(t *testing.T) {
	// This is how it really came from a scan: the same network twice
	// (2.4 and 5 GHz), different signal strength.
	in := []WifiNetwork{
		{SSID: "Example Net 5G", Signal: 62, Secured: true},
		{SSID: "Nachbar", Signal: 30, Secured: true},
		{SSID: "Example Net 5G", Signal: 76, Secured: true, Known: true},
		{SSID: "", Signal: 90},
	}
	got := mergeByStrongest(in)
	if len(got) != 2 {
		t.Fatalf("erwartet 2 Netze, bekam %d: %+v", len(got), got)
	}
	if got[0].SSID != "Example Net 5G" || got[0].Signal != 76 {
		t.Errorf("staerkster Eintrag nicht uebernommen: %+v", got[0])
	}
	// "known" must not get lost just because the stronger entry didn't set it
	// (or vice versa).
	if !got[0].Known {
		t.Errorf("Kennzeichen `Known` beim Zusammenfassen verloren")
	}
	// Order of first appearance is kept — otherwise the list jumps.
	if got[1].SSID != "Nachbar" {
		t.Errorf("Reihenfolge verletzt: %+v", got)
	}
}

func TestRssiToPercent(t *testing.T) {
	cases := []struct {
		dbm  float64
		want int
	}{
		{-50, 100}, // very close
		{-62, 76},  // the value actually measured on a test machine
		{-75, 50},
		{-100, 0},
		{-120, 0},  // out of range -> clamped
		{-20, 100}, // out of range -> clamped
	}
	for _, c := range cases {
		if got := rssiToPercent(c.dbm); got != c.want {
			t.Errorf("rssiToPercent(%v) = %d, erwartet %d", c.dbm, got, c.want)
		}
	}
}

package devicecontrol

// Text parsing of the two `netsh` calls that remain in the Windows Wi-Fi path
// (everything else comes typed from WinRT).
//
// Deliberately WITHOUT a build tag and without process calls: that way the
// tests run on the Linux build host. The fixtures come from real output of a
// German Windows 11, not from the documentation — this is exactly where a
// trap was suspected.
//
// 🔑 The common trick: only the VALUE after the colon is read. The label is
// translated ("Profil fuer alle Benutzer"), the value is not. That makes the
// parsing language-independent without a single German word in the code.

import "strings"

// parseKnownProfiles reads the names of all saved Wi-Fi profiles from the
// output of `netsh wlan show profiles`.
func parseKnownProfiles(raw string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		// 🔑 FIRST colon: the label contains none, but a network name may contain
		// some ("net:with:colon").
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[idx+1:])
		if name == "" {
			continue // heading like "Profile auf Schnittstelle WLAN 9:"
		}
		// Separator lines and placeholders carry no real name.
		if strings.HasPrefix(name, "-") || name == "<Kein>" || name == "<None>" {
			continue
		}
		out[name] = true
	}
	return out
}

// parseConnectedSSID extracts the name of the connected network from the
// output of `netsh wlan show interfaces`. Empty return value = not connected
// (or wired) — that is not an error.
//
// 🔑 "BSSID" must be excluded: that line sits right next to it and carries
// the radio cell's address, not the network name.
func parseConnectedSSID(raw string) string {
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		label := strings.TrimSpace(line[:idx])
		if !strings.HasPrefix(label, "SSID") || strings.HasPrefix(label, "BSSID") {
			continue
		}
		return strings.TrimSpace(line[idx+1:])
	}
	return ""
}

// mergeByStrongest merges network names reported more than once.
//
// 🔑 A network appears once per frequency band (2.4 and 5 GHz are separate
// entries with their own BSSID) — in practice the same router came back twice
// from a scan. But the user picks a name, not a radio cell.
// The order of first appearance is preserved so the list does not jump
// on every scan.
func mergeByStrongest(in []WifiNetwork) []WifiNetwork {
	best := map[string]WifiNetwork{}
	order := []string{}
	for _, n := range in {
		if n.SSID == "" {
			continue // hidden networks have nothing to display
		}
		old, seen := best[n.SSID]
		if !seen {
			order = append(order, n.SSID)
			best[n.SSID] = n
			continue
		}
		if n.Signal > old.Signal {
			// Known/secured are kept if they were set anywhere.
			n.Known = n.Known || old.Known
			n.Secured = n.Secured || old.Secured
			best[n.SSID] = n
		} else {
			old.Known = old.Known || n.Known
			old.Secured = old.Secured || n.Secured
			best[n.SSID] = old
		}
	}
	out := make([]WifiNetwork, 0, len(order))
	for _, s := range order {
		out = append(out, best[s])
	}
	return out
}

// rssiToPercent maps the signal strength in dBm to 0..100.
// -50 dBm and better counts as full, -100 as nothing.
func rssiToPercent(dbm float64) int {
	return clampPct(int(2 * (dbm + 100)))
}

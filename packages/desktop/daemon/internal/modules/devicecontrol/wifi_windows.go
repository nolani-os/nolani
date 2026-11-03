//go:build windows

package devicecontrol

// Wi-Fi on Windows: network list, connected network, connecting.
// The radio switch itself lives in radios_windows.go.
//
// 🔑 Why WinRT instead of `netsh` — three reasons, all measured on a test machine:
//   1. **No plain-text password on disk.** `netsh` can only join an unknown
//      network via a profile XML, and that contains the PSK in plain text.
//      That contradicts the contract promise "clarad never stores the
//      password" (on Linux it goes straight to NetworkManager).
//      `ConnectWithPasswordCredentialAsync` takes the credentials as an object
//      in memory.
//   2. **No localised output to parse.** `netsh` answers in German on a German
//      Windows ("Authentifizierung", "Verschluesselung"); WinRT returns typed
//      values (`RsnaPsk`, `Ccmp`).
//   3. **No admin rights.** `RequestAccessAsync` returns `Allowed` even from a
//      NON-packaged process (measured before a single line of Go was written).
//
// The only exception remains `netsh wlan show profiles` for the question "is
// the network already known?" — WinRT has no equivalent for that. Only the
// value after the colon is read there (the LABEL is localised, the SSID value
// is not), and a misjudgement is harmless: the UI then asks for a password it
// wouldn't have needed.

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unsafe"

	"github.com/saltosystems/winrt-go/windows/foundation"

	"claraos.de/companion/clarad/internal/winrt/credentials"
	"claraos.de/companion/clarad/internal/winrt/wifi"
)

// NetworkAuthenticationType: 0 = None, 2 = Open80211. Everything else is
// some form of encryption.
const (
	authNone      = 0
	authOpen80211 = 2
)

type winWifi struct {
	radio *radioAccess // radio switch
	w     *comWorker   // the same MTA thread
}

// ── Capabilities ───────────────────────────────────────────────────────────

func (w *winWifi) Probe() bool  { return w.radio.present() }
func (w *winWifi) CanSet() bool { return w.radio.canSet() }

// CanConnect: separate permission, independent of the radio switch — it is
// asked afresh on every call (same pattern as polkit on Linux).
func (w *winWifi) CanConnect() bool {
	return w.w.do(func() error { return requestWifiAccess() }) == nil
}

func (w *winWifi) SetEnabled(on bool) error { return w.radio.setEnabled(on) }

// ── State ──────────────────────────────────────────────────────────────────

func (w *winWifi) Get() (WifiState, error) {
	on, err := w.radio.enabled()
	if err != nil {
		return WifiState{}, err
	}
	st := WifiState{Enabled: on}
	if !on {
		return st, nil
	}
	// 🔑 No scan at poll rate: `GetNetworkReport` returns the LAST collected
	// report, `ScanAsync` takes ~2 s. Signal strength therefore comes from the
	// cache — good enough for a display.
	_ = w.w.do(func() error {
		ssid, err := connectedSSID()
		if err != nil || ssid == "" {
			return nil // wired or not connected: `connected` stays empty
		}
		st.Connected = ssid
		if nets, err := cachedNetworks(); err == nil {
			for _, n := range nets {
				if n.SSID == ssid {
					st.Signal = n.Signal
					break
				}
			}
		}
		return nil
	})
	return st, nil
}

// ── Scan ───────────────────────────────────────────────────────────────────

func (w *winWifi) Scan() ([]WifiNetwork, error) {
	var out []WifiNetwork
	err := w.w.do(func() error {
		if err := requestWifiAccess(); err != nil {
			return err
		}
		ad, err := firstAdapter()
		if err != nil {
			return err
		}
		defer ad.Release()

		op, err := ad.ScanAsync()
		if err != nil {
			return err
		}
		defer op.Release()
		if err := awaitAction(op, 15*time.Second); err != nil {
			return err
		}
		nets, err := networksOf(ad)
		if err != nil {
			return err
		}
		out = nets
		return nil
	})
	if err != nil {
		return nil, err
	}
	markKnown(out)
	return out, nil
}

// ── Connect ────────────────────────────────────────────────────────────────

// Connect takes TWO paths, depending on whether Windows already knows the network.
//
// 🔴 **Measured, not assumed**: `WiFiAdapter.ConnectAsync` fails on a network
// for which a Windows profile already exists — with `UnspecifiedFailure`, both
// WITH and WITHOUT credentials. The WiFiAdapter API creates its own profile and
// gets in the way of the existing one. `netsh wlan connect name=…` connects the
// same network right away.
//
// Hence the split:
//   - **known network** -> `netsh wlan connect` with the saved profile.
//     Needs no password at all — Windows already has the key, and clarad
//     never gets to see it. A `psk` sent along is deliberately ignored.
//   - **unknown network** -> WinRT with the credentials in memory.
//     No profile XML, no plain text on disk.
func (w *winWifi) Connect(ssid, psk string) error {
	if strings.TrimSpace(ssid) == "" {
		return badInput("ssid fehlt")
	}
	if knownProfiles()[ssid] {
		return netshConnect(ssid)
	}
	if psk == "" {
		// Open networks exist, but the UI asks for a password when `secured` — if it
		// is missing here, the request is simply incomplete.
		return badInput("unbekanntes Netz braucht ein Passwort: " + ssid)
	}
	return w.w.do(func() error {
		if err := requestWifiAccess(); err != nil {
			return err
		}
		ad, err := firstAdapter()
		if err != nil {
			return err
		}
		defer ad.Release()

		// The report must know the network — otherwise there is no object to connect
		// to. Try the cache first, then scan.
		net, err := findNetwork(ad, ssid, false)
		if err != nil {
			if op, e := ad.ScanAsync(); e == nil {
				_ = awaitAction(op, 15*time.Second)
				op.Release()
			}
			net, err = findNetwork(ad, ssid, false)
		}
		if err != nil {
			return badInput("Netz nicht in Reichweite: " + ssid)
		}
		defer net.Release()

		// 0 = Automatic: Windows reconnects by itself in future.
		const reconnectAutomatic = 0

		var op *foundation.IAsyncOperation
		{
			// 🔑 Credentials as an object — they go straight to Windows and
			// are not stored anywhere by clarad.
			//
			// 🔴 Empty object + SetPassword, NOT the factory method
			// `CreatePasswordCredential(resource, user, pass)`: that requires a non-empty
			// resource AND user name and otherwise fails with "The parameter is
			// incorrect" (measured). A Wi-Fi key has neither.
			cred, e := credentials.NewPasswordCredential()
			if e != nil {
				return e
			}
			if e := cred.SetPassword(psk); e != nil {
				cred.Release()
				return e
			}
			defer cred.Release()
			op, err = ad.ConnectWithPasswordCredentialAsync(net, reconnectAutomatic, cred)
		}
		if err != nil {
			return err
		}
		defer op.Release()
		if err := awaitOp(op, 45*time.Second); err != nil {
			return err
		}

		res, err := op.GetResults()
		if err != nil {
			return err
		}
		result := (*wifi.WiFiConnectionResult)(res)
		defer result.Release()
		status, err := result.GetConnectionStatus()
		if err != nil {
			return err
		}
		// 1 = Success
		if status != 1 {
			return fmt.Errorf("Verbindung fehlgeschlagen: %s", wifiStatusText(status))
		}
		return nil
	})
}

// wifiStatusText translates WiFiConnectionStatus into something readable.
func wifiStatusText(s wifi.WiFiConnectionStatus) string {
	switch s {
	case 0:
		return "unbekannter Fehler"
	case 2:
		return "Zugriff verweigert"
	case 3:
		return "ungueltige Zugangsdaten" // usually: wrong password
	case 4:
		return "Zeitueberschreitung"
	case 5:
		return "Netz nicht verfuegbar"
	case 6:
		return "Verbindung im Gange"
	case 7:
		return "Netz aktuell nicht erreichbar"
	}
	return fmt.Sprintf("Status %d", s)
}

// ── WinRT helpers (run exclusively on the MTA thread) ──────────────────────

func requestWifiAccess() error {
	op, err := wifi.WiFiAdapterRequestAccessAsync()
	if err != nil {
		return err
	}
	defer op.Release()
	if err := awaitOp(op, 10*time.Second); err != nil {
		return err
	}
	res, err := op.GetResults()
	if err != nil {
		return err
	}
	// 1 = Allowed
	if wifi.WiFiAccessStatus(uintptr(res)) != wifi.WiFiAccessStatusAllowed {
		return errUnsupported
	}
	return nil
}

func firstAdapter() (*wifi.WiFiAdapter, error) {
	op, err := wifi.WiFiAdapterFindAllAdaptersAsync()
	if err != nil {
		return nil, err
	}
	defer op.Release()
	if err := awaitOp(op, 10*time.Second); err != nil {
		return nil, err
	}
	res, err := op.GetResults()
	if err != nil {
		return nil, err
	}
	view := (*vectorView)(res)
	n, err := view.size()
	if err != nil || n == 0 {
		return nil, errUnsupported
	}
	item, err := view.at(0)
	if err != nil {
		return nil, err
	}
	return (*wifi.WiFiAdapter)(item), nil
}

// networksOf reads the adapter's current report.
//
// 🔑 Merge duplicate SSIDs: a network appears once per frequency band (2.4 and
// 5 GHz are separate entries with their own BSSID). The user picks a name, not
// a radio cell — so the strongest entry is kept.
func networksOf(ad *wifi.WiFiAdapter) ([]WifiNetwork, error) {
	report, err := ad.GetNetworkReport()
	if err != nil {
		return nil, err
	}
	defer report.Release()
	view, err := report.GetAvailableNetworks()
	if err != nil {
		return nil, err
	}
	defer view.Release()

	size, err := view.GetSize()
	if err != nil {
		return nil, err
	}
	flach := []WifiNetwork{}
	for i := uint32(0); i < size; i++ {
		ptr, err := view.GetAt(i)
		if err != nil {
			continue
		}
		n := (*wifi.WiFiAvailableNetwork)(ptr)
		ssid, err := n.GetSsid()
		if err != nil || ssid == "" {
			n.Release()
			continue // hidden networks have no name to display
		}
		flach = append(flach, WifiNetwork{SSID: ssid, Signal: signalOf(n), Secured: securedOf(n)})
		n.Release()
	}
	return mergeByStrongest(flach), nil
}

// signalOf: map RSSI in dBm to 0..100. -50 dBm and better counts as full,
// -100 as nothing. If the value is missing, fall back to the coarse bars
// (0..4).
func signalOf(n *wifi.WiFiAvailableNetwork) int {
	if dbm, err := n.GetNetworkRssiInDecibelMilliwatts(); err == nil && dbm != 0 {
		return rssiToPercent(dbm)
	}
	if bars, err := n.GetSignalBars(); err == nil {
		return clampPct(int(bars) * 25)
	}
	return 0
}

func securedOf(n *wifi.WiFiAvailableNetwork) bool {
	set, err := n.GetSecuritySettings()
	if err != nil {
		return true // when in doubt, ask for the password instead of swallowing it
	}
	defer set.Release()
	auth, err := set.GetNetworkAuthenticationType()
	if err != nil {
		return true
	}
	return auth != authNone && auth != authOpen80211
}

func findNetwork(ad *wifi.WiFiAdapter, ssid string, _ bool) (*wifi.WiFiAvailableNetwork, error) {
	report, err := ad.GetNetworkReport()
	if err != nil {
		return nil, err
	}
	defer report.Release()
	view, err := report.GetAvailableNetworks()
	if err != nil {
		return nil, err
	}
	defer view.Release()
	size, err := view.GetSize()
	if err != nil {
		return nil, err
	}
	for i := uint32(0); i < size; i++ {
		ptr, err := view.GetAt(i)
		if err != nil {
			continue
		}
		n := (*wifi.WiFiAvailableNetwork)(ptr)
		got, err := n.GetSsid()
		if err == nil && got == ssid {
			return n, nil
		}
		n.Release()
	}
	return nil, fmt.Errorf("SSID nicht im Bericht: %s", ssid)
}

// connectedSSID reads the name of the connected Wi-Fi network.
//
// 🔑 Second and last place using `netsh`. The WinRT path for this would be
// `ConnectionProfile.WlanConnectionProfileDetails.GetConnectedSsid()` — but
// that one class drags in a good dozen further types (NetworkAdapter,
// DataUsage, RoamingStates, WwanConnectionProfileDetails …), all of which
// would have to be generated and carried along. For ONE text field that is the
// wrong trade.
//
// Robust against localised output: we look for the line whose LABEL starts
// with "SSID" — the abbreviation is not translated, and neither is the value
// after it. "BSSID" is excluded. If nothing is found, the name stays empty
// (wired or not connected) — not an error.
func connectedSSID() (string, error) {
	raw, err := exec.Command("netsh", "wlan", "show", "interfaces").Output()
	if err != nil {
		return "", nil
	}
	return parseConnectedSSID(string(raw)), nil
}

// cachedNetworks: report without a new scan (for the signal display in the poll).
func cachedNetworks() ([]WifiNetwork, error) {
	ad, err := firstAdapter()
	if err != nil {
		return nil, err
	}
	defer ad.Release()
	return networksOf(ad)
}

// awaitAction is the counterpart to awaitOp for IAsyncAction (ScanAsync
// returns no result, only "done").
func awaitAction(a *wifi.IAsyncAction, timeout time.Duration) error {
	return awaitAsyncInfo(unsafe.Pointer(a), timeout)
}

// ── "known?" — the only place that still needs netsh ───────────────────────

// markKnown sets the `Known` flag for networks Windows already has a profile
// for. Connecting to saved networks needs no password.
//
// 🔑 Only the value after the last colon is read: the label is localised
// ("Profil fuer alle Benutzer" in German), the SSID value is not. If the
// whole thing fails, `Known=false` remains — the UI then asks for a password
// it wouldn't have needed. No harm done.
func markKnown(nets []WifiNetwork) {
	known := knownProfiles()
	if len(known) == 0 {
		return
	}
	for i := range nets {
		if known[nets[i].SSID] {
			nets[i].Known = true
		}
	}
}

// netshConnect connects via an already saved Windows profile.
// The command only confirms the REQUEST, so the result is measured afterwards
// instead of believed.
func netshConnect(ssid string) error {
	out, err := exec.Command("netsh", "wlan", "connect", "name="+ssid).CombinedOutput()
	if err != nil {
		return fmt.Errorf("netsh wlan connect: %s", strings.TrimSpace(string(out)))
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if got, _ := connectedSSID(); got == ssid {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("Verbindung mit %q kam nicht zustande", ssid)
}

func knownProfiles() map[string]bool {
	raw, err := exec.Command("netsh", "wlan", "show", "profiles").Output()
	if err != nil {
		return map[string]bool{}
	}
	return parseKnownProfiles(string(raw))
}

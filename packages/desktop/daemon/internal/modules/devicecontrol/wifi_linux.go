//go:build linux

package devicecontrol

import (
	"fmt"
	"os/user"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
)

// nmWifi controls Wi-Fi via NetworkManager (system bus, without root).
//
// 🔑 Two measurements on the target laptop (NM 1.54.3) shape the design:
//
//  1. polkit answers the same action differently depending on the session. In
//     the user's active Wayland session `enable-disable-wifi: yes` applies,
//     over SSH without a session `no`. The capability is therefore NOT frozen
//     at module start but asked of NM itself at most every 30 s
//     (GetPermissions) — clarad never guesses, it asks.
//
//  2. `settings.modify.system` requires admin rights (auth_admin_keep),
//     `settings.modify.own` does not. Newly created profiles therefore get
//     `connection.permissions = user:<user>` — so the profile counts as the
//     user's own and NM allows it without a password dialog. Without this line
//     every connect to an unknown network fails silently at polkit.
type nmWifi struct {
	mu      sync.Mutex
	permsAt time.Time
	canSet  bool
	canConn bool
}

const (
	nmSvc       = "org.freedesktop.NetworkManager"
	nmPath      = dbus.ObjectPath("/org/freedesktop/NetworkManager")
	nmSetPath   = dbus.ObjectPath("/org/freedesktop/NetworkManager/Settings")
	nmDevIf     = nmSvc + ".Device"
	nmWlanIf    = nmSvc + ".Device.Wireless"
	nmAPIf      = nmSvc + ".AccessPoint"
	nmConnIf    = nmSvc + ".Settings.Connection"
	nmActIf     = nmSvc + ".Connection.Active"
	nmDevWifi   = uint32(2) // NM_DEVICE_TYPE_WIFI
	nmAPPriv    = uint32(1) // NM_802_11_AP_FLAGS_PRIVACY
	permsMaxAge = 30 * time.Second
	// Connecting: NM reports success/failure asynchronously. This is how long we
	// wait for a verdict before answering the user.
	connectTimeout = 12 * time.Second
)

func (n *nmWifi) Probe() bool {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return false
	}
	defer conn.Close()
	// No Wi-Fi device (wired desktop) => cap absent, not an error.
	dev, err := nmWifiDevice(conn)
	return err == nil && dev != ""
}

func (n *nmWifi) Get() (WifiState, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return WifiState{}, err
	}
	defer conn.Close()

	st := WifiState{}
	v, err := conn.Object(nmSvc, nmPath).GetProperty(nmSvc + ".WirelessEnabled")
	if err != nil {
		return WifiState{}, err
	}
	st.Enabled, _ = v.Value().(bool)
	if !st.Enabled {
		return st, nil
	}

	dev, err := nmWifiDevice(conn)
	if err != nil || dev == "" {
		return st, nil
	}
	ap, err := conn.Object(nmSvc, dev).GetProperty(nmWlanIf + ".ActiveAccessPoint")
	if err != nil {
		return st, nil
	}
	apPath, _ := ap.Value().(dbus.ObjectPath)
	if apPath == "" || apPath == "/" {
		return st, nil // radio on, but not connected
	}
	props, err := getAllProps(conn, nmSvc, apPath, nmAPIf)
	if err != nil {
		return st, nil
	}
	st.Connected = apSSID(props)
	if s, ok := props["Strength"].Value().(uint8); ok {
		st.Signal = int(s)
	}
	return st, nil
}

func (n *nmWifi) SetEnabled(on bool) error {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Object(nmSvc, nmPath).
		SetProperty(nmSvc+".WirelessEnabled", dbus.MakeVariant(on))
}

func (n *nmWifi) CanSet() bool     { s, _ := n.perms(); return s }
func (n *nmWifi) CanConnect() bool { _, c := n.perms(); return c }

// perms asks NM what the calling process may do — with a 30 s cache.
// "auth" (polkit would prompt) deliberately counts as NO: a service without a
// screen cannot answer a password dialog, and a tile that runs into an
// invisible dialog on click is worse than none.
func (n *nmWifi) perms() (canSet, canConnect bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if time.Since(n.permsAt) < permsMaxAge {
		return n.canSet, n.canConn
	}
	n.permsAt = time.Now()
	n.canSet, n.canConn = false, false

	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return false, false
	}
	defer conn.Close()
	var p map[string]string
	if err := conn.Object(nmSvc, nmPath).Call(nmSvc+".GetPermissions", 0).Store(&p); err != nil {
		return false, false
	}
	n.canSet = p[nmSvc+".enable-disable-wifi"] == "yes"
	n.canConn = p[nmSvc+".network-control"] == "yes" &&
		p[nmSvc+".settings.modify.own"] == "yes"
	return n.canSet, n.canConn
}

func (n *nmWifi) Scan() ([]WifiNetwork, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	dev, err := nmWifiDevice(conn)
	if err != nil || dev == "" {
		return nil, errUnsupported
	}

	// Error deliberately ignored: NM rejects a scan shortly after the last one with
	// "not allowed immediately following previous scan" — then we simply return
	// the most recently found networks instead of an error message.
	_ = conn.Object(nmSvc, dev).
		Call(nmWlanIf+".RequestScan", 0, map[string]dbus.Variant{}).Err
	time.Sleep(1500 * time.Millisecond)

	var aps []dbus.ObjectPath
	if err := conn.Object(nmSvc, dev).Call(nmWlanIf+".GetAllAccessPoints", 0).Store(&aps); err != nil {
		return nil, err
	}
	known := nmKnownSSIDs(conn)

	// A network often broadcasts from several access points — per SSID the
	// strongest is kept, otherwise "HomeNet" appears four times in the list.
	best := map[string]WifiNetwork{}
	for _, p := range aps {
		props, err := getAllProps(conn, nmSvc, p, nmAPIf)
		if err != nil {
			continue
		}
		ssid := apSSID(props)
		if ssid == "" {
			continue // hidden network: not clickable without a name
		}
		strength := 0
		if s, ok := props["Strength"].Value().(uint8); ok {
			strength = int(s)
		}
		flags, _ := props["Flags"].Value().(uint32)
		wpa, _ := props["WpaFlags"].Value().(uint32)
		rsn, _ := props["RsnFlags"].Value().(uint32)
		net := WifiNetwork{
			SSID:    ssid,
			Signal:  strength,
			Secured: flags&nmAPPriv != 0 || wpa != 0 || rsn != 0,
			Known:   known[ssid],
		}
		if cur, ok := best[ssid]; !ok || net.Signal > cur.Signal {
			best[ssid] = net
		}
	}
	out := make([]WifiNetwork, 0, len(best))
	for _, v := range best {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Signal > out[j].Signal })
	return out, nil
}

func (n *nmWifi) Connect(ssid, psk string) error {
	if ssid == "" || len(ssid) > 32 {
		return badInput("ssid fehlt oder ist laenger als 32 Zeichen")
	}
	if psk != "" && (len(psk) < 8 || len(psk) > 63) {
		return badInput("psk muss 8..63 Zeichen haben")
	}
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	dev, err := nmWifiDevice(conn)
	if err != nil || dev == "" {
		return errUnsupported
	}
	apPath := nmFindAP(conn, dev, ssid)

	saved := nmFindSavedConnection(conn, ssid)
	var active dbus.ObjectPath
	var added dbus.ObjectPath

	if saved != "" {
		// Known network: activate the profile. A password sent along here would have
		// no effect — the profile brings its own.
		err = conn.Object(nmSvc, nmPath).
			Call(nmSvc+".ActivateConnection", 0, saved, dev, apPath).Store(&active)
	} else {
		settings, serr := nmNewWifiSettings(ssid, psk)
		if serr != nil {
			return serr
		}
		err = conn.Object(nmSvc, nmPath).
			Call(nmSvc+".AddAndActivateConnection", 0, settings, dev, apPath).
			Store(&added, &active)
	}
	if err != nil {
		return fmt.Errorf("NetworkManager: %w", err)
	}

	if werr := nmAwaitActive(conn, active); werr != nil {
		// 🔑 A freshly created but failed profile MUST go: otherwise the network
		// counts as "known" on the next attempt, the UI no longer asks for the
		// password and the user keeps clicking against the same wrong password
		// forever.
		if added != "" {
			_ = conn.Object(nmSvc, added).Call(nmConnIf+".Delete", 0).Err
		}
		return werr
	}
	return nil
}

// nmAwaitActive waits for NM's verdict: activated or failed.
func nmAwaitActive(conn *dbus.Conn, active dbus.ObjectPath) error {
	if active == "" || active == "/" {
		return nil
	}
	deadline := time.Now().Add(connectTimeout)
	for time.Now().Before(deadline) {
		v, err := conn.Object(nmSvc, active).GetProperty(nmActIf + ".State")
		if err != nil {
			// Object gone = NM discarded the activation.
			return devError{msg: "Verbindung abgebrochen (Passwort falsch?)", kind: "backend"}
		}
		switch s, _ := v.Value().(uint32); s {
		case 2: // ACTIVATED
			return nil
		case 3, 4: // DEACTIVATING, DEACTIVATED
			return devError{msg: "Verbindung fehlgeschlagen (Passwort falsch?)", kind: "backend"}
		}
		time.Sleep(300 * time.Millisecond)
	}
	// A timeout is no proof of failure — NM sometimes hangs in DHCP. The UI then
	// sees the success via device.changed.
	return nil
}

// nmNewWifiSettings builds a profile OWNED by the calling user
// (see header comment: otherwise settings.modify.system = auth_admin applies).
func nmNewWifiSettings(ssid, psk string) (map[string]map[string]dbus.Variant, error) {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return nil, fmt.Errorf("Nutzername nicht ermittelbar: %w", err)
	}
	s := map[string]map[string]dbus.Variant{
		"connection": {
			"id":          dbus.MakeVariant(ssid),
			"type":        dbus.MakeVariant("802-11-wireless"),
			"autoconnect": dbus.MakeVariant(true),
			"permissions": dbus.MakeVariant([]string{"user:" + u.Username}),
		},
		"802-11-wireless": {
			"ssid": dbus.MakeVariant([]byte(ssid)),
			"mode": dbus.MakeVariant("infrastructure"),
		},
		"ipv4": {"method": dbus.MakeVariant("auto")},
		"ipv6": {"method": dbus.MakeVariant("auto")},
	}
	if psk != "" {
		s["802-11-wireless-security"] = map[string]dbus.Variant{
			"key-mgmt": dbus.MakeVariant("wpa-psk"),
			"psk":      dbus.MakeVariant(psk),
		}
	}
	return s, nil
}

// ── Helpers ────────────────────────────────────────────────────────────────

// nmWifiDevice returns the path of the first Wi-Fi device ("" if there is none).
func nmWifiDevice(conn *dbus.Conn) (dbus.ObjectPath, error) {
	var devs []dbus.ObjectPath
	if err := conn.Object(nmSvc, nmPath).Call(nmSvc+".GetDevices", 0).Store(&devs); err != nil {
		return "", err
	}
	for _, d := range devs {
		v, err := conn.Object(nmSvc, d).GetProperty(nmDevIf + ".DeviceType")
		if err != nil {
			continue
		}
		if t, _ := v.Value().(uint32); t == nmDevWifi {
			return d, nil
		}
	}
	return "", nil
}

// apSSID: NM delivers the SSID as a byte array — it is radio input, hence
// untrusted. Non-printable characters are removed before the name ends up
// anywhere (the Rust side re-serialises the JSON, but cleanliness starts
// here).
func apSSID(props map[string]dbus.Variant) string {
	raw, _ := props["Ssid"].Value().([]byte)
	if len(raw) == 0 {
		return ""
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, string(raw))
}

func nmFindAP(conn *dbus.Conn, dev dbus.ObjectPath, ssid string) dbus.ObjectPath {
	var aps []dbus.ObjectPath
	if err := conn.Object(nmSvc, dev).Call(nmWlanIf+".GetAllAccessPoints", 0).Store(&aps); err != nil {
		return "/"
	}
	best, bestStrength := dbus.ObjectPath("/"), -1
	for _, p := range aps {
		props, err := getAllProps(conn, nmSvc, p, nmAPIf)
		if err != nil || apSSID(props) != ssid {
			continue
		}
		s := 0
		if v, ok := props["Strength"].Value().(uint8); ok {
			s = int(v)
		}
		if s > bestStrength {
			best, bestStrength = p, s
		}
	}
	return best
}

// nmSavedWifi calls f for every saved Wi-Fi profile. If f returns true, the
// loop ends (for "first match" searches).
func nmSavedWifi(conn *dbus.Conn, f func(path dbus.ObjectPath, ssid string) bool) {
	var conns []dbus.ObjectPath
	if err := conn.Object(nmSvc, nmSetPath).
		Call(nmSvc+".Settings.ListConnections", 0).Store(&conns); err != nil {
		return
	}
	for _, c := range conns {
		var settings map[string]map[string]dbus.Variant
		if err := conn.Object(nmSvc, c).Call(nmConnIf+".GetSettings", 0).Store(&settings); err != nil {
			continue
		}
		w, ok := settings["802-11-wireless"]
		if !ok {
			continue
		}
		raw, _ := w["ssid"].Value().([]byte)
		if len(raw) == 0 {
			continue
		}
		if f(c, string(raw)) {
			return
		}
	}
}

func nmKnownSSIDs(conn *dbus.Conn) map[string]bool {
	known := map[string]bool{}
	nmSavedWifi(conn, func(_ dbus.ObjectPath, ssid string) bool {
		known[ssid] = true
		return false
	})
	return known
}

func nmFindSavedConnection(conn *dbus.Conn, ssid string) dbus.ObjectPath {
	var found dbus.ObjectPath
	nmSavedWifi(conn, func(p dbus.ObjectPath, s string) bool {
		if s == ssid {
			found = p
			return true
		}
		return false
	})
	return found
}

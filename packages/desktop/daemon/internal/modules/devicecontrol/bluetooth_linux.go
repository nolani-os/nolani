//go:build linux

package devicecontrol

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// bluezBT controls Bluetooth via BlueZ (system bus, without root).
//
// Unlike NetworkManager, nothing here depends on polkit: BlueZ's D-Bus policy
// allows every local user to call org.bluez (verified, even without an active
// session). Capabilities therefore depend only on WHETHER an adapter exists.
//
// Deliberately NOT included: pairing. That needs a counterpart for PIN
// prompts (Agent1) and belongs in the system UI — we only operate devices
// that are already paired.
type bluezBT struct{}

const (
	bzSvc     = "org.bluez"
	bzAdapter = "org.bluez.Adapter1"
	bzDevice  = "org.bluez.Device1"
	// Connecting to headphones regularly takes several seconds; without a cap the
	// HTTP call hangs indefinitely.
	btCallTimeout = 20 * time.Second
)

var btAddrRe = regexp.MustCompile(`^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)

func (b *bluezBT) Probe() bool {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return false
	}
	defer conn.Close()
	objs, err := bzObjects(conn)
	if err != nil {
		return false
	}
	_, _, ok := bzAdapterPath(objs)
	return ok
}

func (b *bluezBT) CanSet() bool { return true }

// CanConnect: BlueZ knows the paired devices and can connect them.
// Windows only reports the radio switch via the Radios API — the cap is
// absent there, which is why it is separate from switching.
func (b *bluezBT) CanConnect() bool { return true }

func (b *bluezBT) Get() (BluetoothState, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return BluetoothState{}, err
	}
	defer conn.Close()
	objs, err := bzObjects(conn)
	if err != nil {
		return BluetoothState{}, err
	}
	_, props, ok := bzAdapterPath(objs)
	if !ok {
		return BluetoothState{}, errUnsupported
	}
	st := BluetoothState{Connected: []BluetoothDevice{}}
	st.Enabled, _ = props["Powered"].Value().(bool)
	for _, d := range bzDevices(objs) {
		if d.Connected {
			st.Connected = append(st.Connected, d)
		}
	}
	return st, nil
}

func (b *bluezBT) SetEnabled(on bool) error {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	objs, err := bzObjects(conn)
	if err != nil {
		return err
	}
	path, _, ok := bzAdapterPath(objs)
	if !ok {
		return errUnsupported
	}
	if err := conn.Object(bzSvc, path).SetProperty(bzAdapter+".Powered", dbus.MakeVariant(on)); err != nil {
		// rfkill: a hardware switch or a block is in front of it — that is not a
		// program error but a statement about the device.
		if strings.Contains(err.Error(), "Blocked") {
			return devError{msg: "Bluetooth ist gesperrt (Hardware-Schalter/rfkill)", kind: "backend"}
		}
		return err
	}
	return nil
}

func (b *bluezBT) Devices() ([]BluetoothDevice, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	objs, err := bzObjects(conn)
	if err != nil {
		return nil, err
	}
	out := []BluetoothDevice{}
	for _, d := range bzDevices(objs) {
		if d.Paired || d.Connected {
			out = append(out, d)
		}
	}
	// Connected first, then alphabetical — the list should show at the top what
	// is actually on right now.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Connected != out[j].Connected {
			return out[i].Connected
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func (b *bluezBT) Connect(address string, disconnect bool) error {
	if !btAddrRe.MatchString(address) {
		return badInput("address muss die Form AA:BB:CC:DD:EE:FF haben")
	}
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	objs, err := bzObjects(conn)
	if err != nil {
		return err
	}
	var target dbus.ObjectPath
	var paired bool
	for path, ifaces := range objs {
		props, ok := ifaces[bzDevice]
		if !ok {
			continue
		}
		addr, _ := props["Address"].Value().(string)
		if !strings.EqualFold(addr, address) {
			continue
		}
		target = path
		paired, _ = props["Paired"].Value().(bool)
		break
	}
	if target == "" {
		return badInput("unbekanntes Geraet: " + address)
	}
	if !paired && !disconnect {
		return badInput("Geraet ist nicht gekoppelt — Kopplung erfolgt in den Systemeinstellungen")
	}

	method := bzDevice + ".Connect"
	if disconnect {
		method = bzDevice + ".Disconnect"
	}
	ctx, cancel := context.WithTimeout(context.Background(), btCallTimeout)
	defer cancel()
	if call := conn.Object(bzSvc, target).CallWithContext(ctx, method, 0); call.Err != nil {
		return devError{msg: "Bluetooth: " + call.Err.Error(), kind: "backend"}
	}
	return nil
}

// ── Helpers ────────────────────────────────────────────────────────────────

type bzObjectMap map[dbus.ObjectPath]map[string]map[string]dbus.Variant

func bzObjects(conn *dbus.Conn) (bzObjectMap, error) {
	var objs bzObjectMap
	err := conn.Object(bzSvc, "/").
		Call("org.freedesktop.DBus.ObjectManager.GetManagedObjects", 0).Store(&objs)
	return objs, err
}

// bzAdapterPath returns the first adapter. Several adapters on laptops are the
// exception; we deliberately serve only the first instead of building a
// selection nobody needs.
func bzAdapterPath(objs bzObjectMap) (dbus.ObjectPath, map[string]dbus.Variant, bool) {
	paths := make([]string, 0, 2)
	for p, ifaces := range objs {
		if _, ok := ifaces[bzAdapter]; ok {
			paths = append(paths, string(p))
		}
	}
	if len(paths) == 0 {
		return "", nil, false
	}
	sort.Strings(paths) // stable choice: hci0 before hci1
	p := dbus.ObjectPath(paths[0])
	return p, objs[p][bzAdapter], true
}

func bzDevices(objs bzObjectMap) []BluetoothDevice {
	out := make([]BluetoothDevice, 0, len(objs))
	for _, ifaces := range objs {
		props, ok := ifaces[bzDevice]
		if !ok {
			continue
		}
		addr, _ := props["Address"].Value().(string)
		if addr == "" {
			continue
		}
		name, _ := props["Alias"].Value().(string)
		if name == "" {
			name, _ = props["Name"].Value().(string)
		}
		if name == "" {
			name = addr
		}
		d := BluetoothDevice{Address: addr, Name: name}
		d.Connected, _ = props["Connected"].Value().(bool)
		d.Paired, _ = props["Paired"].Value().(bool)
		out = append(out, d)
	}
	return out
}

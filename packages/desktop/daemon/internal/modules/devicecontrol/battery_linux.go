//go:build linux

package devicecontrol

import (
	"github.com/godbus/dbus/v5"
)

// upowerBattery reads the battery level via UPower (system bus, read-only,
// without root). The main source is the aggregated DisplayDevice; in addition,
// peripherals with their own battery (mouse, keyboard, headset) are listed.
type upowerBattery struct{}

const (
	upSvc    = "org.freedesktop.UPower"
	upDevIf  = "org.freedesktop.UPower.Device"
	upDispPa = dbus.ObjectPath("/org/freedesktop/UPower/devices/DisplayDevice")
)

// UPower Device.State: 1=charging, 2=discharging, 4=fully-charged,
// 5=pending-charge. Device.Type: 2=battery, 5=mouse, 6=keyboard.
func chargingState(s uint32) bool { return s == 1 || s == 4 || s == 5 }

func (u *upowerBattery) Probe() bool {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return false
	}
	defer conn.Close()
	props, err := getAllProps(conn, upSvc, upDispPa, upDevIf)
	if err != nil {
		return false
	}
	// Desktop without battery: DisplayDevice exists, IsPresent is false —
	// then the cap is absent (negative test on desktop machines).
	present, _ := props["IsPresent"].Value().(bool)
	return present
}

func (u *upowerBattery) Get() (BatteryState, error) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return BatteryState{}, err
	}
	defer conn.Close()
	props, err := getAllProps(conn, upSvc, upDispPa, upDevIf)
	if err != nil {
		return BatteryState{}, err
	}
	st := BatteryState{}
	if pct, ok := props["Percentage"].Value().(float64); ok {
		st.Percent = int(pct + 0.5)
	}
	if s, ok := props["State"].Value().(uint32); ok {
		st.Charging = chargingState(s)
	}
	if tte, ok := props["TimeToEmpty"].Value().(int64); ok {
		st.TimeToEmptyMin = int(tte / 60)
	}

	// Peripherals (best effort — errors here leave the main value intact).
	var paths []dbus.ObjectPath
	if err := conn.Object(upSvc, "/org/freedesktop/UPower").
		Call(upSvc+".EnumerateDevices", 0).Store(&paths); err == nil {
		for _, p := range paths {
			if p == upDispPa {
				continue
			}
			dp, err := getAllProps(conn, upSvc, p, upDevIf)
			if err != nil {
				continue
			}
			typ, _ := dp["Type"].Value().(uint32)
			present, _ := dp["IsPresent"].Value().(bool)
			// everything except the laptop battery itself (Type 2) and power supplies (1)
			if !present || typ <= 2 {
				continue
			}
			name, _ := dp["Model"].Value().(string)
			pct, _ := dp["Percentage"].Value().(float64)
			if name == "" {
				continue
			}
			st.Devices = append(st.Devices, BatteryDevice{Name: name, Percent: int(pct + 0.5)})
		}
	}
	return st, nil
}

func getAllProps(conn *dbus.Conn, svc string, path dbus.ObjectPath, iface string) (map[string]dbus.Variant, error) {
	var props map[string]dbus.Variant
	err := conn.Object(svc, path).
		Call("org.freedesktop.DBus.Properties.GetAll", 0, iface).Store(&props)
	return props, err
}

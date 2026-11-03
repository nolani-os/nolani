//go:build linux

package devicecontrol

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/godbus/dbus/v5"
)

// dbusBrightness: screen brightness without root. Probe chain (the Plasma
// D-Bus interface has moved around between versions):
//
//  1. Plasma >=6.2: service org.kde.ScreenBrightness (session bus), one
//     object per display under /org/kde/ScreenBrightness with Brightness/
//     MaxBrightness + SetBrightness.
//  2. Older Plasma/PowerDevil: org.kde.Solid.PowerManagement
//     .../Actions/BrightnessControl with brightness()/brightnessMax()/
//     setBrightness().
//  3. Fallback without KDE: read sysfs + logind SetBrightness (system bus,
//     allowed for the active session without root).
//
// Probe = successful read. A set error in chain 1/2 is therefore only visible
// at runtime — the end-to-end test checks the write path explicitly.
type dbusBrightness struct {
	backend string // "kde-sb" | "powerdevil" | "login1"

	// kde-sb
	displayPath dbus.ObjectPath
	// login1
	sysfsDev string
	maxRaw   int
}

const (
	sbService = "org.kde.ScreenBrightness"
	sbRoot    = dbus.ObjectPath("/org/kde/ScreenBrightness")
	sbDispIf  = "org.kde.ScreenBrightness.Display"

	pdService = "org.kde.Solid.PowerManagement"
	pdPath    = dbus.ObjectPath("/org/kde/Solid/PowerManagement/Actions/BrightnessControl")
	pdIf      = "org.kde.Solid.PowerManagement.Actions.BrightnessControl"
)

func (b *dbusBrightness) Probe() bool {
	if conn, err := dbus.ConnectSessionBus(); err == nil {
		// Chain 1: ScreenBrightness — first display with readable brightness.
		var names []string
		obj := conn.Object(sbService, sbRoot)
		if v, err := obj.GetProperty(sbService + ".DisplaysDBusNames"); err == nil {
			_ = v.Store(&names)
		}
		for _, n := range names {
			p := dbus.ObjectPath(string(sbRoot) + "/" + n)
			if _, _, err := b.readKdeSb(conn, p); err == nil {
				b.backend, b.displayPath = "kde-sb", p
				conn.Close()
				return true
			}
		}
		// Chain 2: legacy PowerDevil path.
		var cur int32
		if err := conn.Object(pdService, pdPath).Call(pdIf+".brightness", 0).Store(&cur); err == nil {
			b.backend = "powerdevil"
			conn.Close()
			return true
		}
		conn.Close()
	}
	// Chain 3: sysfs + logind.
	matches, _ := filepath.Glob("/sys/class/backlight/*")
	for _, dir := range matches {
		maxB, err1 := readIntFile(filepath.Join(dir, "max_brightness"))
		_, err2 := readIntFile(filepath.Join(dir, "brightness"))
		if err1 == nil && err2 == nil && maxB > 0 {
			b.backend, b.sysfsDev, b.maxRaw = "login1", filepath.Base(dir), maxB
			return true
		}
	}
	return false
}

func (b *dbusBrightness) CanSet() bool { return true }

func (b *dbusBrightness) Get() (BrightnessState, error) {
	switch b.backend {
	case "kde-sb":
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			return BrightnessState{}, err
		}
		defer conn.Close()
		cur, max, err := b.readKdeSb(conn, b.displayPath)
		if err != nil || max <= 0 {
			return BrightnessState{}, fmt.Errorf("ScreenBrightness lesen: %w", err)
		}
		return BrightnessState{Level: int(float64(cur)/float64(max)*100 + 0.5)}, nil
	case "powerdevil":
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			return BrightnessState{}, err
		}
		defer conn.Close()
		var cur, max int32
		obj := conn.Object(pdService, pdPath)
		if err := obj.Call(pdIf+".brightness", 0).Store(&cur); err != nil {
			return BrightnessState{}, err
		}
		if err := obj.Call(pdIf+".brightnessMax", 0).Store(&max); err != nil || max <= 0 {
			return BrightnessState{}, fmt.Errorf("brightnessMax lesen: %v", err)
		}
		return BrightnessState{Level: int(float64(cur)/float64(max)*100 + 0.5)}, nil
	default: // login1/sysfs
		cur, err := readIntFile(filepath.Join("/sys/class/backlight", b.sysfsDev, "brightness"))
		if err != nil {
			return BrightnessState{}, err
		}
		return BrightnessState{Level: int(float64(cur)/float64(b.maxRaw)*100 + 0.5)}, nil
	}
}

func (b *dbusBrightness) Set(level int) error {
	switch b.backend {
	case "kde-sb":
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			return err
		}
		defer conn.Close()
		_, max, err := b.readKdeSb(conn, b.displayPath)
		if err != nil || max <= 0 {
			return fmt.Errorf("MaxBrightness lesen: %v", err)
		}
		raw := int32(float64(level) / 100 * float64(max))
		// Signature (i brightness, u flags); flags 0 = immediate, without OSD.
		return conn.Object(sbService, b.displayPath).
			Call(sbDispIf+".SetBrightness", 0, raw, uint32(0)).Err
	case "powerdevil":
		conn, err := dbus.ConnectSessionBus()
		if err != nil {
			return err
		}
		defer conn.Close()
		obj := conn.Object(pdService, pdPath)
		var max int32
		if err := obj.Call(pdIf+".brightnessMax", 0).Store(&max); err != nil || max <= 0 {
			return fmt.Errorf("brightnessMax lesen: %v", err)
		}
		raw := int32(float64(level) / 100 * float64(max))
		return obj.Call(pdIf+".setBrightness", 0, raw).Err
	default: // login1: SetBrightness for our own active session, without root
		conn, err := dbus.ConnectSystemBus()
		if err != nil {
			return err
		}
		defer conn.Close()
		raw := uint32(float64(level) / 100 * float64(b.maxRaw))
		return conn.Object("org.freedesktop.login1",
			"/org/freedesktop/login1/session/auto").
			Call("org.freedesktop.login1.Session.SetBrightness", 0,
				"backlight", b.sysfsDev, raw).Err
	}
}

func (b *dbusBrightness) readKdeSb(conn *dbus.Conn, p dbus.ObjectPath) (cur, max int32, err error) {
	obj := conn.Object(sbService, p)
	vCur, err := obj.GetProperty(sbDispIf + ".Brightness")
	if err != nil {
		return 0, 0, err
	}
	vMax, err := obj.GetProperty(sbDispIf + ".MaxBrightness")
	if err != nil {
		return 0, 0, err
	}
	if err := vCur.Store(&cur); err != nil {
		return 0, 0, err
	}
	if err := vMax.Store(&max); err != nil {
		return 0, 0, err
	}
	return cur, max, nil
}

func readIntFile(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

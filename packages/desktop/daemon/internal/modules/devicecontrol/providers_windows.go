//go:build windows

package devicecontrol

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"claraos.de/companion/clarad/internal/winrt/radios"
)

// Windows: battery + storage (read-only, plain syscalls), audio/mic/device
// selection via WASAPI (audio_windows.go).
// Everything stays compatible with CGO_ENABLED=0 + the cargo-xwin cross
// build — go-wca and go-ole are pure Go.

// 🔑 A single COM thread for all three audio providers: COM is thread-affine,
// and nobody needed a second apartment (see wasapi_windows.go). Created only
// when the first provider is built.
var audioCOM = newAudioWorker()

// 🔴 Second thread for WinRT: radios need the MTA, WASAPI the STA.
var radioCOM = newRadioWorker()

func newAudioProvider() audioProvider           { return &winAudio{w: audioCOM} }
func newBrightnessProvider() brightnessProvider { return nil }
func newBatteryProvider() batteryProvider       { return &winBattery{} }
func newStorageProvider() storageProvider       { return &winStorage{} }

// Privacy: Windows itself keeps track of who uses the microphone/camera.
func newPrivacyProvider() privacyProvider { return &winPrivacy{} }

func newMicProvider() micProvider                   { return &winMic{w: audioCOM} }
func newAudioDevicesProvider() audioDevicesProvider { return &winAudioDevices{w: audioCOM} }

// Radios: Bluetooth via the Radios API (switch), Wi-Fi combined — switch from
// there, network list/connect via Windows.Devices.WiFi.
func newWifiProvider() wifiProvider {
	return &winWifi{
		radio: &radioAccess{w: radioCOM, kind: radios.RadioKindWiFi},
		w:     radioCOM, // WinRT wants the MTA — the same thread
	}
}

func newBluetoothProvider() bluetoothProvider {
	return &winBluetooth{a: &radioAccess{w: radioCOM, kind: radios.RadioKindBluetooth}}
}

// Brightness (WMI, internal panels only) is not built yet — until then the cap
// is absent, and the endpoint answers 501 instead of with a white lie.

// ── Battery: GetSystemPowerStatus ───────────────────────────────────────────

var (
	modkernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemPowerStatus = modkernel32.NewProc("GetSystemPowerStatus")
)

type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

type winBattery struct{}

func (b *winBattery) read() (systemPowerStatus, error) {
	var st systemPowerStatus
	r, _, err := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&st)))
	if r == 0 {
		return st, fmt.Errorf("GetSystemPowerStatus: %v", err)
	}
	return st, nil
}

func (b *winBattery) Probe() bool {
	st, err := b.read()
	// BatteryFlag 128 = "no system battery" (desktop PCs)
	// → cap absent; 255 = unknown → don't offer it either.
	return err == nil && st.BatteryFlag != 128 && st.BatteryFlag != 255
}

func (b *winBattery) Get() (BatteryState, error) {
	st, err := b.read()
	if err != nil {
		return BatteryState{}, err
	}
	out := BatteryState{Charging: st.ACLineStatus == 1}
	if st.BatteryLifePercent != 255 {
		out.Percent = int(st.BatteryLifePercent)
	}
	if st.BatteryLifeTime != 0xFFFFFFFF {
		out.TimeToEmptyMin = int(st.BatteryLifeTime / 60)
	}
	return out, nil
}

// ── Storage: GetLogicalDrives + GetDiskFreeSpaceEx ──────────────────────────

type winStorage struct{}

func (s *winStorage) Probe() bool {
	mask, err := windows.GetLogicalDrives()
	return err == nil && mask != 0
}

func (s *winStorage) Get() ([]MountState, error) {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil, err
	}
	var out []MountState
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		rootPtr, _ := windows.UTF16PtrFromString(root)
		dtype := windows.GetDriveType(rootPtr)
		// Real drives only: 2=removable (USB), 3=fixed. CD-ROM/network excluded.
		if dtype != windows.DRIVE_REMOVABLE && dtype != windows.DRIVE_FIXED {
			continue
		}
		var freeAvail, total, totalFree uint64
		if err := windows.GetDiskFreeSpaceEx(rootPtr, &freeAvail, &total, &totalFree); err != nil {
			continue // card reader without medium etc.
		}
		out = append(out, MountState{
			Mount:     root,
			Label:     string(rune('A'+i)) + ":",
			TotalGB:   round1(float64(total) / 1e9),
			FreeGB:    round1(float64(freeAvail) / 1e9),
			Removable: dtype == windows.DRIVE_REMOVABLE,
		})
	}
	return out, nil
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

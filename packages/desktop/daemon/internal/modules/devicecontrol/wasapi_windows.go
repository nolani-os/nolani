//go:build windows

package devicecontrol

// WASAPI foundations for the Windows audio providers.
//
// All calls run on a dedicated STA thread (comthread_windows.go); the reason
// is given there.
//
// Proven on Windows 11 (build 26200) before integration, with a standalone
// .exe.

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/moutend/go-wca/pkg/wca"
)

// EDataFlow: go-wca only defines ERender (0); Capture is the next value.
const (
	wcaRender = wca.ERender // output
	eCapture  = wca.ERender + 1
)

// newAudioWorker: STA thread for WASAPI.
func newAudioWorker() *comWorker {
	return newWorker(
		func() error { return ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED) },
		ole.CoUninitialize,
	)
}

// ── Endpoint helpers (run exclusively on the COM thread) ────────────────────

func newEnumerator() (*wca.IMMDeviceEnumerator, error) {
	var mmde *wca.IMMDeviceEnumerator
	if err := wca.CoCreateInstance(wca.CLSID_MMDeviceEnumerator, 0, ole.CLSCTX_ALL,
		wca.IID_IMMDeviceEnumerator, &mmde); err != nil {
		return nil, fmt.Errorf("MMDeviceEnumerator: %w", err)
	}
	return mmde, nil
}

// defaultEndpoint returns the default device of the eConsole role — the one
// Windows uses for normal playback or capture.
func defaultEndpoint(flow uint32) (*wca.IMMDevice, error) {
	mmde, err := newEnumerator()
	if err != nil {
		return nil, err
	}
	defer mmde.Release()
	var mmd *wca.IMMDevice
	if err := mmde.GetDefaultAudioEndpoint(flow, wca.EConsole, &mmd); err != nil {
		// No device in this direction (machine without microphone) — no cap.
		return nil, errUnsupported
	}
	return mmd, nil
}

func endpointName(mmd *wca.IMMDevice) string {
	var ps *wca.IPropertyStore
	if err := mmd.OpenPropertyStore(wca.STGM_READ, &ps); err != nil {
		return ""
	}
	defer ps.Release()
	var pv wca.PROPVARIANT
	if err := ps.GetValue(&wca.PKEY_Device_FriendlyName, &pv); err != nil {
		return ""
	}
	return pv.String()
}

func endpointVolume(mmd *wca.IMMDevice) (*wca.IAudioEndpointVolume, error) {
	var aev *wca.IAudioEndpointVolume
	if err := mmd.Activate(wca.IID_IAudioEndpointVolume, ole.CLSCTX_ALL, nil, &aev); err != nil {
		return nil, fmt.Errorf("IAudioEndpointVolume: %w", err)
	}
	return aev, nil
}

// readEndpoint reads name, volume (0..100) and mute state.
func readEndpoint(flow uint32) (name string, volume int, muted bool, err error) {
	mmd, err := defaultEndpoint(flow)
	if err != nil {
		return "", 0, false, err
	}
	defer mmd.Release()
	name = endpointName(mmd)

	aev, err := endpointVolume(mmd)
	if err != nil {
		return "", 0, false, err
	}
	defer aev.Release()

	var level float32
	if err := aev.GetMasterVolumeLevelScalar(&level); err != nil {
		return "", 0, false, err
	}
	if err := aev.GetMute(&muted); err != nil {
		return "", 0, false, err
	}
	return name, pctFromScalar(level), muted, nil
}

// writeEndpoint sets only the given (non-nil) fields.
func writeEndpoint(flow uint32, volume *int, muted *bool) error {
	mmd, err := defaultEndpoint(flow)
	if err != nil {
		return err
	}
	defer mmd.Release()
	aev, err := endpointVolume(mmd)
	if err != nil {
		return err
	}
	defer aev.Release()

	if volume != nil {
		if err := aev.SetMasterVolumeLevelScalar(scalarFromPct(*volume), nil); err != nil {
			return err
		}
	}
	if muted != nil {
		if err := aev.SetMute(*muted, nil); err != nil {
			return err
		}
	}
	return nil
}

// listEndpoints returns all active devices of both directions.
func listEndpoints() ([]AudioDevice, error) {
	mmde, err := newEnumerator()
	if err != nil {
		return nil, err
	}
	defer mmde.Release()

	out := []AudioDevice{}
	for _, f := range []struct {
		flow uint32
		kind string
	}{{wca.ERender, "sink"}, {eCapture, "source"}} {
		defaultID := ""
		var def *wca.IMMDevice
		if err := mmde.GetDefaultAudioEndpoint(f.flow, wca.EConsole, &def); err == nil {
			_ = def.GetId(&defaultID)
			def.Release()
		}

		var col *wca.IMMDeviceCollection
		// DEVICE_STATE_ACTIVE: unplugged or disabled devices stay out — a selection
		// should only show what actually makes sound.
		if err := mmde.EnumAudioEndpoints(f.flow, wca.DEVICE_STATE_ACTIVE, &col); err != nil {
			// If one direction is missing entirely, that is not an error of the whole.
			continue
		}
		var count uint32
		if err := col.GetCount(&count); err != nil {
			col.Release()
			continue
		}
		for i := uint32(0); i < count; i++ {
			var mmd *wca.IMMDevice
			if err := col.Item(i, &mmd); err != nil {
				continue
			}
			var id string
			if err := mmd.GetId(&id); err != nil {
				mmd.Release()
				continue
			}
			name := endpointName(mmd)
			mmd.Release()
			if name == "" {
				continue // useless for a selection without a display name
			}
			out = append(out, AudioDevice{ID: id, Name: name, Kind: f.kind, Default: id == defaultID})
		}
		col.Release()
	}
	return out, nil
}

// ── Switching the default device (IPolicyConfig) ────────────────────────────
//
// 🔴 Windows has NO documented interface for this. The path the popular tools
// take as well (AudioDeviceCmdlets, SoundSwitch, nircmd) is the undocumented
// COM interface IPolicyConfig — go-wca doesn't know it, so the vtable is
// called by hand.
//
// Precisely because it is undocumented, it is probed at runtime: if it
// disappears (Windows update), the cap `audio.devices.set` is absent and the
// UI shows the device list without a switcher — instead of a dead button.

var (
	clsidPolicyConfigClient = ole.NewGUID("{870AF99C-171D-4F9E-AF0D-E63DF40C2BC9}")
	iidPolicyConfig         = ole.NewGUID("{F8679F50-850A-41CF-9C72-430F290290C8}")
)

// vtable index 13 = SetDefaultEndpoint: 3 IUnknown slots, then
// GetMixFormat, GetDeviceFormat, ResetDeviceFormat, SetDeviceFormat,
// GetProcessingPeriod, SetProcessingPeriod, GetShareMode, SetShareMode,
// GetPropertyValue, SetPropertyValue (= 10), then SetDefaultEndpoint.
const vtblSetDefaultEndpoint = 13

// Roles: 0 = eConsole, 1 = eMultimedia. 2 = eCommunications is deliberately
// left alone — Windows keeps a separate setting for telephony, and switching
// it there would surprise the user during calls.
var defaultEndpointRoles = []uintptr{0, 1}

func policyConfigAvailable() bool {
	unk, err := ole.CreateInstance(clsidPolicyConfigClient, iidPolicyConfig)
	if err != nil {
		return false
	}
	unk.Release()
	return true
}

func setDefaultEndpoint(deviceID string) error {
	unk, err := ole.CreateInstance(clsidPolicyConfigClient, iidPolicyConfig)
	if err != nil {
		return errUnsupported
	}
	defer unk.Release()

	idPtr, err := syscall.UTF16PtrFromString(deviceID)
	if err != nil {
		return badInput("ungueltige Geraete-Kennung")
	}
	vtbl := *(**[32]uintptr)(unsafe.Pointer(unk))
	for _, role := range defaultEndpointRoles {
		hr, _, _ := syscall.SyscallN(vtbl[vtblSetDefaultEndpoint],
			uintptr(unsafe.Pointer(unk)),
			uintptr(unsafe.Pointer(idPtr)),
			role)
		if hr != 0 {
			return fmt.Errorf("SetDefaultEndpoint(role=%d): HRESULT 0x%X", role, hr)
		}
	}
	return nil
}

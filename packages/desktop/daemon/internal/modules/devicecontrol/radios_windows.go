//go:build windows

package devicecontrol

// Radio switches on Windows: Bluetooth and Wi-Fi on/off via
// Windows.Devices.Radios.
//
// 🔑 Why WinRT and not netsh: `netsh interface set interface … admin=…`
// requires admin rights — the companion deliberately runs without. The Radios
// API is the only way to switch the radio from a normal user process.
// Measured up front (PowerShell, before any line of Go):
// `RequestAccessAsync` -> `Allowed` from a NON-packaged process,
// `GetRadiosAsync` reports `WLAN 9`/WiFi and `Bluetooth`/Bluetooth.
//
// The bindings are generated under internal/winrt/radios (see the README there).

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/saltosystems/winrt-go/windows/foundation"

	"claraos.de/companion/clarad/internal/winrt/radios"
)

// ── Thread + access ────────────────────────────────────────────────────────

// 🔴 Own thread with MTA: WASAPI runs in the STA, both on one thread
// gives RPC_E_CHANGED_MODE (see comthread_windows.go).
func newRadioWorker() *comWorker {
	// No cleanup counterpart: go-ole offers no RoUninitialize, and the thread
	// lives as long as the daemon anyway.
	return newWorker(
		func() error { return ole.RoInitialize(1) }, // 1 = RO_INIT_MULTITHREADED
		nil,
	)
}

// IAsyncInfo — the status side of every WinRT async operation.
const (
	iidAsyncInfo        = "{00000036-0000-0000-C000-000000000046}"
	vtblAsyncInfoStatus = 7 // 6 IInspectable slots, then get_Id, get_Status

	asyncStarted   = 0
	asyncCompleted = 1
)

// awaitOp waits for an async operation to finish.
//
// 🔑 Deliberately polled via IAsyncInfo.Status instead of SetCompleted: the
// Completed handler needs the PARAMETERISED IID of
// AsyncOperationCompletedHandler<T> — which would have to be computed per
// result type. The status path is type-independent and needs no callback
// (and in the MTA no message loop is needed for it either).
func awaitOp(op *foundation.IAsyncOperation, timeout time.Duration) error {
	return awaitAsyncInfo(unsafe.Pointer(op), timeout)
}

// awaitAsyncInfo works on the raw pointer so the same code serves
// IAsyncOperation (with result) and IAsyncAction (without).
func awaitAsyncInfo(p unsafe.Pointer, timeout time.Duration) error {
	unk := (*ole.IUnknown)(p)
	info, err := unk.QueryInterface(ole.NewGUID(iidAsyncInfo))
	if err != nil {
		return fmt.Errorf("IAsyncInfo: %w", err)
	}
	defer info.Release()

	vtbl := *(**[16]uintptr)(unsafe.Pointer(info))
	deadline := time.Now().Add(timeout)
	for {
		var status int32
		hr, _, _ := syscall.SyscallN(vtbl[vtblAsyncInfoStatus],
			uintptr(unsafe.Pointer(info)), uintptr(unsafe.Pointer(&status)))
		if hr != 0 {
			return ole.NewError(hr)
		}
		switch {
		case status == asyncCompleted:
			return nil
		case status != asyncStarted:
			// 2 = canceled, 3 = error
			return fmt.Errorf("Funk-Abfrage endete mit Status %d", status)
		case time.Now().After(deadline):
			return fmt.Errorf("Funk-Abfrage antwortet nicht")
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// requestRadioAccess is mandatory before a radio may be switched.
func requestRadioAccess() error {
	op, err := radios.RadioRequestAccessAsync()
	if err != nil {
		return err
	}
	defer op.Release()
	if err := awaitOp(op, 5*time.Second); err != nil {
		return err
	}
	res, err := op.GetResults()
	if err != nil {
		return err
	}
	// Enum result: the value is directly in the out parameter.
	if radios.RadioAccessStatus(uintptr(res)) != radios.RadioAccessStatusAllowed {
		return errUnsupported
	}
	return nil
}

// eachRadio calls fn for every radio of the requested kind.
func eachRadio(kind radios.RadioKind, fn func(r *radios.Radio) error) error {
	op, err := radios.RadioGetRadiosAsync()
	if err != nil {
		return err
	}
	defer op.Release()
	if err := awaitOp(op, 5*time.Second); err != nil {
		return err
	}
	res, err := op.GetResults()
	if err != nil {
		return err
	}
	// IVectorView<Radio>: the vtable is the same for every T, only the IID
	// differs — and the object comes out ready-made here.
	view := (*vectorView)(res)
	size, err := view.size()
	if err != nil {
		return err
	}
	for i := uint32(0); i < size; i++ {
		item, err := view.at(i)
		if err != nil {
			continue
		}
		r := (*radios.Radio)(item)
		k, err := r.GetKind()
		if err != nil || k != kind {
			r.Release()
			continue
		}
		err = fn(r)
		r.Release()
		if err != nil {
			return err
		}
	}
	return nil
}

// ── IVectorView (only GetAt/GetSize, nothing more is needed) ───────────────

type vectorView struct{ ole.IUnknown }

const (
	vtblVectorViewGetAt   = 6
	vtblVectorViewGetSize = 7
)

func (v *vectorView) size() (uint32, error) {
	vtbl := *(**[16]uintptr)(unsafe.Pointer(v))
	var out uint32
	hr, _, _ := syscall.SyscallN(vtbl[vtblVectorViewGetSize],
		uintptr(unsafe.Pointer(v)), uintptr(unsafe.Pointer(&out)))
	if hr != 0 {
		return 0, ole.NewError(hr)
	}
	return out, nil
}

func (v *vectorView) at(i uint32) (unsafe.Pointer, error) {
	vtbl := *(**[16]uintptr)(unsafe.Pointer(v))
	var out unsafe.Pointer
	hr, _, _ := syscall.SyscallN(vtbl[vtblVectorViewGetAt],
		uintptr(unsafe.Pointer(v)), uintptr(i), uintptr(unsafe.Pointer(&out)))
	if hr != 0 {
		return nil, ole.NewError(hr)
	}
	return out, nil
}

// ── Shared radio access ────────────────────────────────────────────────────

type radioAccess struct {
	w    *comWorker
	kind radios.RadioKind
}

// present: is there a radio of this kind?
func (a *radioAccess) present() bool {
	found := false
	_ = a.w.do(func() error {
		return eachRadio(a.kind, func(r *radios.Radio) error {
			found = true
			return nil
		})
	})
	return found
}

// enabled: on if AT LEAST one device of this kind is on.
func (a *radioAccess) enabled() (bool, error) {
	on := false
	err := a.w.do(func() error {
		return eachRadio(a.kind, func(r *radios.Radio) error {
			st, err := r.GetState()
			if err != nil {
				return err
			}
			if st == radios.RadioStateOn {
				on = true
			}
			return nil
		})
	})
	return on, err
}

// canSet: may this process switch? Asked afresh on every call — the
// permission depends on the user and the privacy settings and must not be
// frozen at module start (same pattern as polkit on Linux).
func (a *radioAccess) canSet() bool {
	return a.w.do(func() error { return requestRadioAccess() }) == nil
}

func (a *radioAccess) setEnabled(on bool) error {
	target := radios.RadioStateOff
	if on {
		target = radios.RadioStateOn
	}
	return a.w.do(func() error {
		if err := requestRadioAccess(); err != nil {
			return err
		}
		return eachRadio(a.kind, func(r *radios.Radio) error {
			op, err := r.SetStateAsync(target)
			if err != nil {
				return err
			}
			defer op.Release()
			return awaitOp(op, 10*time.Second)
		})
	})
}

// ── Bluetooth ──────────────────────────────────────────────────────────────

type winBluetooth struct{ a *radioAccess }

func (b *winBluetooth) Probe() bool  { return b.a.present() }
func (b *winBluetooth) CanSet() bool { return b.a.canSet() }

// 🔴 This API cannot name connected devices — that would need
// Windows.Devices.Enumeration with the Bluetooth selector. So Windows reports
// NO device list and the cap `bluetooth.connect` is absent there (separate
// from `bluetooth.set`), instead of presenting an empty list as the truth.
// Still open.
func (b *winBluetooth) CanConnect() bool { return false }

func (b *winBluetooth) Get() (BluetoothState, error) {
	on, err := b.a.enabled()
	if err != nil {
		return BluetoothState{}, err
	}
	return BluetoothState{Enabled: on, Connected: []BluetoothDevice{}}, nil
}

func (b *winBluetooth) SetEnabled(on bool) error { return b.a.setEnabled(on) }

func (b *winBluetooth) Devices() ([]BluetoothDevice, error) {
	return []BluetoothDevice{}, nil
}

func (b *winBluetooth) Connect(address string, disconnect bool) error {
	return errUnsupported
}

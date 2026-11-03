//go:build windows

package state

// Windows has no Unix file modes → config.json is encrypted as a whole with
// DPAPI (user scope). Only the same Windows user on the same machine can
// decrypt it — appropriate for family PCs, and needs no extra deps besides
// golang.org/x/sys (which tailscale.com brings anyway).

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/windows"
)

// dpapiMagic allows detecting "already encrypted?" (migration/robustness).
var dpapiMagic = []byte("CLARADPAPI1\x00")

func encryptSecrets(plain []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	enc := unsafe.Slice(out.Data, out.Size)
	return append(append([]byte{}, dpapiMagic...), enc...), nil
}

func decryptSecrets(stored []byte) ([]byte, error) {
	if !bytes.HasPrefix(stored, dpapiMagic) {
		// Plain text (e.g. placed by hand) — tolerated; encrypted on the next
		// save.
		return stored, nil
	}
	raw := stored[len(dpapiMagic):]
	in := windows.DataBlob{Size: uint32(len(raw)), Data: &raw[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte{}, unsafe.Slice(out.Data, out.Size)...), nil
}

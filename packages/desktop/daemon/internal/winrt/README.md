# `internal/winrt/*` — generated WinRT bindings

Applies to **all** packages here: `radios` (radio switches), `wifi` (network
list and connecting), `connectivity` (security settings of a network) and
`credentials` (password object).

Note — **two manual edits** to the generated files, both deliberate:
- `wifi/iasyncaction.go` is written **by hand** — winrt-go does not publish
  `Windows.Foundation.IAsyncAction`, but `ScanAsync` returns exactly that.
  The type only carries an IUnknown; waiting happens via `IAsyncInfo`.
- One or two **unused methods were removed** from each of `wifi/wifiadapter.go`
  and `credentials/passwordcredential.go` (`GetNetworkAdapter`,
  `GetProperties`). They pulled in types winrt-go does not publish
  (`NetworkAdapter`, `IPropertySet`) — for functions we don't need.
  Anyone regenerating must repeat these two cuts.

IMPORTANT — **not vendored**: `Windows.Networking.Connectivity.ConnectionProfile`.
It would have provided the connected network name, but pulls in a good dozen
further types (NetworkAdapter, DataUsage, RoamingStates, Wwan…). For one text
field that's the wrong trade — the name comes from
`netsh wlan show interfaces` instead (see `connectedSSID` in `wifi_windows.go`).

---

## `radios` in particular

**Do not edit by hand.** The four `.go` files come from the
[winrt-go](https://github.com/saltosystems/winrt-go) generator and are kept in
the repo so the build stays reproducible (no generator run, no network while
building). The generator itself is **not** a dependency of the daemon — only
the runtime package `winrt-go/windows/foundation` is.

Why a local path instead of an import: winrt-go does not ship the namespace
`Windows.Devices.Radios` pre-generated; it only comes into existence through
the generator. The only change to the files is the package line/import path —
the code itself is unchanged.

## Regenerating

```sh
docker run --rm -v "$PWD:/src" -w /src golang:1.26 sh -c '
  go mod init gen
  for c in Windows.Devices.Radios.Radio \
           Windows.Devices.Radios.RadioState \
           Windows.Devices.Radios.RadioKind \
           Windows.Devices.Radios.RadioAccessStatus; do
    GOFLAGS=-mod=mod go run github.com/saltosystems/winrt-go/cmd/winrt-go-gen@latest -class $c
  done'
# then copy windows/devices/radios/*.go here
```

## Why

Windows only lets Wi-Fi and Bluetooth radios be switched **without admin
rights** through this API (`netsh interface set interface` requires
administrator). Measured on a Windows test machine: `RequestAccessAsync` →
`Allowed` from an unpackaged process, `GetRadiosAsync` reports both radios.

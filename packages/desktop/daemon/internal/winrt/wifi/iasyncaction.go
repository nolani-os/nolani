package wifi

// IAsyncAction — added by hand, NOT generated.
//
// winrt-go does not publish `Windows.Foundation.IAsyncAction` (only
// `IAsyncOperation`), but `WiFiAdapter.ScanAsync` returns exactly that.
// The type is a pure IUnknown carrier: waiting happens via `IAsyncInfo`
// (QueryInterface); there is no result to collect.

import "github.com/go-ole/go-ole"

type IAsyncAction struct {
	ole.IUnknown
}

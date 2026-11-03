package devicecontrol

// Types of the device-control contract (protocol/control-api.md, section
// "Device control"). Sections are absent from the JSON when the cap is missing.

type AudioState struct {
	Volume int    `json:"volume"` // 0..100
	Muted  bool   `json:"muted"`
	Sink   string `json:"sink,omitempty"`
}

type BrightnessState struct {
	Level int `json:"level"` // 0..100
}

type BatteryDevice struct {
	Name    string `json:"name"`
	Percent int    `json:"percent"`
}

type BatteryState struct {
	Percent        int             `json:"percent"`
	Charging       bool            `json:"charging"`
	TimeToEmptyMin int             `json:"time_to_empty_min"`
	Devices        []BatteryDevice `json:"devices,omitempty"`
}

type MountState struct {
	Mount     string  `json:"mount"`
	Label     string  `json:"label,omitempty"`
	TotalGB   float64 `json:"total_gb"`
	FreeGB    float64 `json:"free_gb"`
	Removable bool    `json:"removable"`
}

// MicState is the `mic` section — the device's microphone. Volume/Source are
// optional: Android only delivers `muted`, Linux both.
type MicState struct {
	Muted  bool   `json:"muted"`
	Volume int    `json:"volume,omitempty"` // 0..100
	Source string `json:"source,omitempty"` // human-readable name
}

// AudioDevice is an entry from GET /v1/device/audio/devices.
type AudioDevice struct {
	ID      string `json:"id"`   // stable identifier (pactl name)
	Name    string `json:"name"` // display name
	Kind    string `json:"kind"` // sink = output, source = capture
	Default bool   `json:"default"`
}

// WifiState is the `wifi` section. Connected empty = not connected
// (the shell then expects null, hence omitempty).
type WifiState struct {
	Enabled   bool   `json:"enabled"`
	Connected string `json:"connected,omitempty"`
	Signal    int    `json:"signal,omitempty"` // 0..100
}

// WifiNetwork is an entry from GET /v1/device/wifi/networks.
type WifiNetwork struct {
	SSID    string `json:"ssid"`
	Signal  int    `json:"signal"`  // 0..100
	Secured bool   `json:"secured"` // encryption active
	Known   bool   `json:"known"`   // profile already exists -> no PSK needed
}

type BluetoothDevice struct {
	Address   string `json:"address"`
	Name      string `json:"name"`
	Connected bool   `json:"connected"`
	Paired    bool   `json:"paired"`
}

// BluetoothState: `connected` deliberately as a list (contract control-api.md)
// — an adapter can hold several devices at once.
type BluetoothState struct {
	Enabled   bool              `json:"enabled"`
	Connected []BluetoothDevice `json:"connected"`
}

// PrivacyUse is a section of the privacy indicator: is anyone using the
// microphone or camera right now, and if so, who?
//
// 🔑 `Apps` carries display names, not paths — "Discord" instead of
// "C:\Users\…\app-1.0.9011\Discord.exe". For display the path is noise, and it
// reveals more about the machine than necessary.
type PrivacyUse struct {
	InUse bool     `json:"in_use"`
	Apps  []string `json:"apps,omitempty"`
}

// PrivacyState is the `privacy` section. Camera is absent if the device has
// none — a dead "Camera: no" row helps nobody.
type PrivacyState struct {
	Mic    *PrivacyUse `json:"mic,omitempty"`
	Camera *PrivacyUse `json:"camera,omitempty"`
}

// DeviceState is the full snapshot for GET /v1/device/state.
type DeviceState struct {
	Caps       []string         `json:"caps"`
	Audio      *AudioState      `json:"audio,omitempty"`
	Brightness *BrightnessState `json:"brightness,omitempty"`
	Battery    *BatteryState    `json:"battery,omitempty"`
	Storage    []MountState     `json:"storage,omitempty"`
	Mic        *MicState        `json:"mic,omitempty"`
	Wifi       *WifiState       `json:"wifi,omitempty"`
	Bluetooth  *BluetoothState  `json:"bluetooth,omitempty"`
	Privacy    *PrivacyState    `json:"privacy,omitempty"`
}

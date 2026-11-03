package devicecontrol

// Provider interfaces per section. Each platform supplies constructors
// (providers_linux.go / providers_windows.go); Probe() decides at module
// start whether the cap exists — a failed probe is NOT an error, the
// capability is then simply absent (contract: control-api.md).

type audioProvider interface {
	Probe() bool
	Get() (AudioState, error)
	// Set changes only the non-nil fields.
	Set(volume *int, muted *bool) error
	CanSet() bool
}

type brightnessProvider interface {
	Probe() bool
	Get() (BrightnessState, error)
	Set(level int) error
	CanSet() bool
}

type batteryProvider interface {
	// Probe returns false if there is no battery (desktop PC) —
	// an important negative test on a desktop machine.
	Probe() bool
	Get() (BatteryState, error)
}

type storageProvider interface {
	Probe() bool
	Get() ([]MountState, error)
}

// micProvider: the device's microphone (mute/level). Deliberately a section of
// its own instead of a field in `audio` — output and capture have separate
// devices, separate permissions and separate tiles.
type micProvider interface {
	Probe() bool
	Get() (MicState, error)
	// Set changes only the non-nil fields.
	Set(muted *bool, volume *int) error
	CanSet() bool
}

// audioDevicesProvider: choice between headphones, speakers, headset.
//
// Reading and switching are SEPARATE capabilities: on Linux pactl can do both,
// on Windows switching depends on the undocumented IPolicyConfig and may
// disappear with an update. If it does, the UI shows the list without a
// switcher (VolumeTray.tsx already distinguishes `audio.devices` and
// `audio.devices.set`) instead of a dead button.
type audioDevicesProvider interface {
	Probe() bool
	CanSetDefault() bool
	List() ([]AudioDevice, error)
	SetDefault(kind, id string) error
}

// wifiProvider: reading and writing are SEPARATE capabilities. CanSet/
// CanConnect may change at runtime — on Linux they depend on polkit, and
// polkit answers depending on whether the user's session is currently
// `Active` (measured on a laptop: the same action returns "yes" in an active
// session, "no" over SSH without a session). So the module asks regularly
// instead of freezing the answer from module start.
type wifiProvider interface {
	Probe() bool
	Get() (WifiState, error)
	SetEnabled(on bool) error
	CanSet() bool
	CanConnect() bool
	// Scan triggers a scan and returns the networks found (takes ~2 s).
	Scan() ([]WifiNetwork, error)
	// Connect connects to ssid; psk only for an unknown, secured network.
	// The password goes straight into the operating system's management —
	// clarad writes it nowhere and does not keep it.
	Connect(ssid, psk string) error
}

// bluetoothProvider: radio switch and device list are SEPARATE capabilities.
// BlueZ can do both; the Windows Radios API only knows the switch (devices
// would need Windows.Devices.Enumeration) — there `bluetooth.connect` is
// absent, instead of presenting an empty list as the truth.
type bluetoothProvider interface {
	Probe() bool
	Get() (BluetoothState, error)
	SetEnabled(on bool) error
	CanSet() bool
	CanConnect() bool
	// Devices returns known (paired) devices. Pairing remains the OS's job.
	Devices() ([]BluetoothDevice, error)
	Connect(address string, disconnect bool) error
}

// privacyProvider: "who is using the camera and microphone right now?" — read
// only. Deliberately NO switch: hard-disabling the camera from the user context
// is not possible on any of the three systems (muting belongs to micProvider).
type privacyProvider interface {
	Probe() bool
	Get() (PrivacyState, error)
}

//go:build linux

package devicecontrol

// Linux constructors (KDE desktop target, without root): wpctl for PipeWire,
// D-Bus (godbus) for brightness/battery, /proc + statfs for storage.

func newAudioProvider() audioProvider               { return &wpctlAudio{} }
func newBrightnessProvider() brightnessProvider     { return &dbusBrightness{} }
func newBatteryProvider() batteryProvider           { return &upowerBattery{} }
func newStorageProvider() storageProvider           { return &procStorage{} }
func newMicProvider() micProvider                   { return &pactlMic{} }
func newAudioDevicesProvider() audioDevicesProvider { return &pactlDevices{} }
func newWifiProvider() wifiProvider                 { return &nmWifi{} }
func newBluetoothProvider() bluetoothProvider       { return &bluezBT{} }

// The privacy indicator is not built yet on Linux (approach: /dev/video* +
// open file descriptors in /proc). Until then the `privacy` cap is absent.
func newPrivacyProvider() privacyProvider { return nil }

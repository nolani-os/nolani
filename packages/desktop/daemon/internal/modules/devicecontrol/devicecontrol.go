// Package devicecontrol: control of the LOCAL device (volume, brightness,
// battery, storage, Wi-Fi, Bluetooth, audio devices, privacy).
//
// Deliberately lives in the daemon (control channel outside the controlled
// session, registry.go) and is reachable ONLY via the local control API, i.e.
// only through the local user's Tauri process. No consent gate needed;
// remote access will later go through the three-gate model.
//
// Change detection: poll every 3 s + diff. Events are coalesced per section to
// >=500 ms — every event ends up as w.eval in a WebKitGTK instance with a
// history of crashes, so this path is deliberately throttled. D-Bus
// PropertiesChanged signals instead of polling would be a later optimisation.
package devicecontrol

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"time"
)

const (
	pollInterval  = 3 * time.Second
	coalesceDelay = 500 * time.Millisecond
)

// Error classes for the control API (501/400/502, contract control-api.md).
type devError struct {
	msg  string
	kind string // "unsupported" | "badinput" | "backend"
}

func (e devError) Error() string { return e.msg }

func IsUnsupported(err error) bool { de, ok := err.(devError); return ok && de.kind == "unsupported" }
func IsBadInput(err error) bool    { de, ok := err.(devError); return ok && de.kind == "badinput" }

var errUnsupported = devError{msg: "auf diesem Geraet nicht verfuegbar", kind: "unsupported"}

func badInput(msg string) error { return devError{msg: msg, kind: "badinput"} }

// ChangedEvent is the data of the SSE event `device.changed`.
type ChangedEvent struct {
	Section string          `json:"section"`
	State   json.RawMessage `json:"state"`
}

type Module struct {
	emit func(ChangedEvent)

	audio      audioProvider
	brightness brightnessProvider
	battery    batteryProvider
	storage    storageProvider
	mic        micProvider
	audioDevs  audioDevicesProvider
	wifi       wifiProvider
	privacy    privacyProvider
	bluetooth  bluetoothProvider

	mu    sync.Mutex
	caps  []string
	state DeviceState
	// dirty: sections with unreported changes (coalescing buffer).
	dirty map[string]json.RawMessage

	cancel context.CancelFunc
}

// New probes all providers and builds the cap list. emit delivers changes to
// the outside (daemon -> SSE `device.changed`).
func New(emit func(ChangedEvent)) *Module {
	m := &Module{emit: emit, dirty: map[string]json.RawMessage{}}
	if p := newAudioProvider(); p != nil && p.Probe() {
		m.audio = p
		m.caps = append(m.caps, "audio")
		if p.CanSet() {
			m.caps = append(m.caps, "audio.set")
		}
	}
	if p := newBrightnessProvider(); p != nil && p.Probe() {
		m.brightness = p
		m.caps = append(m.caps, "brightness")
		if p.CanSet() {
			m.caps = append(m.caps, "brightness.set")
		}
	}
	if p := newBatteryProvider(); p != nil && p.Probe() {
		m.battery = p
		m.caps = append(m.caps, "battery")
	}
	if p := newStorageProvider(); p != nil && p.Probe() {
		m.storage = p
		m.caps = append(m.caps, "storage")
	}
	if p := newMicProvider(); p != nil && p.Probe() {
		// Get() has a say: a machine without a capture device has pactl but no
		// microphone — then the cap is missing instead of showing an empty tile.
		if _, err := p.Get(); err == nil {
			m.mic = p
			m.caps = append(m.caps, "mic")
			if p.CanSet() {
				m.caps = append(m.caps, "mic.set")
			}
		}
	}
	if p := newAudioDevicesProvider(); p != nil && p.Probe() {
		m.audioDevs = p
		m.caps = append(m.caps, "audio.devices")
		// Switching may be missing without making the list worthless
		// (Windows: IPolicyConfig is undocumented).
		if p.CanSetDefault() {
			m.caps = append(m.caps, "audio.devices.set")
		}
	}
	if p := newPrivacyProvider(); p != nil && p.Probe() {
		m.privacy = p
		m.caps = append(m.caps, "privacy")
	}
	if p := newWifiProvider(); p != nil && p.Probe() {
		m.wifi = p
		m.caps = append(m.caps, "wifi")
		// wifi.set/wifi.connect depend on the session (polkit) and are therefore
		// NOT fixed here but set in refresh().
	}
	if p := newBluetoothProvider(); p != nil && p.Probe() {
		m.bluetooth = p
		m.caps = append(m.caps, "bluetooth")
		if p.CanSet() {
			m.caps = append(m.caps, "bluetooth.set")
		}
		// Connecting may be missing without making the radio switch worthless
		// (the Windows Radios API has no device list).
		if p.CanConnect() {
			m.caps = append(m.caps, "bluetooth.connect")
		}
	}
	m.refresh() // initial snapshot before anyone calls State()
	return m
}

func (m *Module) ID() string { return "device-control" }

// Start runs until ctx ends: poll + diff + coalesced emit.
func (m *Module) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.cancel = cancel
	m.mu.Unlock()

	go func() {
		poll := time.NewTicker(pollInterval)
		flush := time.NewTicker(coalesceDelay)
		defer poll.Stop()
		defer flush.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-poll.C:
				m.refresh()
			case <-flush.C:
				m.flushDirty()
			}
		}
	}()
	return nil
}

func (m *Module) Stop() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
}

// State returns the full snapshot (GET /v1/device/state).
func (m *Module) State() DeviceState {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.state
	st.Caps = m.caps
	return st
}

// audioOrEmpty: response body for calls that return the audio section without
// an audio provider having to exist.
func (s DeviceState) audioOrEmpty() AudioState {
	if s.Audio == nil {
		return AudioState{}
	}
	return *s.Audio
}

func (m *Module) HasCap(c string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, have := range m.caps {
		if have == c {
			return true
		}
	}
	return false
}

// SetAudio changes volume and/or mute; nil fields stay untouched.
func (m *Module) SetAudio(volume *int, muted *bool) (AudioState, error) {
	if m.audio == nil || !m.audio.CanSet() {
		return AudioState{}, errUnsupported
	}
	if volume == nil && muted == nil {
		return AudioState{}, badInput("volume oder muted fehlt")
	}
	if volume != nil && (*volume < 0 || *volume > 100) {
		return AudioState{}, badInput("volume ausserhalb 0..100")
	}
	if err := m.audio.Set(volume, muted); err != nil {
		return AudioState{}, err
	}
	st, err := m.audio.Get()
	if err != nil {
		return AudioState{}, err
	}
	// Via updateSection instead of writing directly: otherwise the poll diff no
	// longer sees a change and API sets NEVER produce a device.changed — other
	// windows/clients would stay silent (the shell swallows the echo within a
	// 400 ms window; it EXPECTS these events).
	m.updateSection("audio", m.stateAudioSlot, st)
	return st, nil
}

func (m *Module) SetBrightness(level int) (BrightnessState, error) {
	if m.brightness == nil || !m.brightness.CanSet() {
		return BrightnessState{}, errUnsupported
	}
	if level < 0 || level > 100 {
		return BrightnessState{}, badInput("level ausserhalb 0..100")
	}
	if err := m.brightness.Set(level); err != nil {
		return BrightnessState{}, err
	}
	st, err := m.brightness.Get()
	if err != nil {
		return BrightnessState{}, err
	}
	// As with SetAudio: mark dirty so the set emits a device.changed.
	m.updateSection("brightness", m.stateBrightnessSlot, st)
	return st, nil
}

// SetMic changes mute and/or capture level.
func (m *Module) SetMic(muted *bool, volume *int) (MicState, error) {
	if m.mic == nil || !m.mic.CanSet() {
		return MicState{}, errUnsupported
	}
	if muted == nil && volume == nil {
		return MicState{}, badInput("muted oder volume fehlt")
	}
	if volume != nil && (*volume < 0 || *volume > 100) {
		return MicState{}, badInput("volume ausserhalb 0..100")
	}
	if err := m.mic.Set(muted, volume); err != nil {
		return MicState{}, err
	}
	st, err := m.mic.Get()
	if err != nil {
		return MicState{}, err
	}
	m.updateSection("mic", m.stateMicSlot, st)
	return st, nil
}

// AudioDevices lists output and capture devices.
func (m *Module) AudioDevices() ([]AudioDevice, error) {
	if m.audioDevs == nil {
		return nil, errUnsupported
	}
	return m.audioDevs.List()
}

// SetDefaultAudioDevice switches output or capture.
func (m *Module) SetDefaultAudioDevice(kind, id string) (AudioState, error) {
	if m.audioDevs == nil {
		return AudioState{}, errUnsupported
	}
	if id == "" {
		return AudioState{}, badInput("id fehlt")
	}
	if err := m.audioDevs.SetDefault(kind, id); err != nil {
		return AudioState{}, err
	}
	// Switching changes the volume AND mic section (different device, different
	// values) — refresh both immediately instead of waiting for the poll.
	if m.audio != nil {
		if st, err := m.audio.Get(); err == nil {
			m.updateSection("audio", m.stateAudioSlot, st)
		}
	}
	if m.mic != nil {
		if st, err := m.mic.Get(); err == nil {
			m.updateSection("mic", m.stateMicSlot, st)
		}
	}
	return m.State().audioOrEmpty(), nil
}

// SetWifiEnabled turns the radio on or off.
func (m *Module) SetWifiEnabled(on bool) (WifiState, error) {
	if m.wifi == nil || !m.wifi.CanSet() {
		return WifiState{}, errUnsupported
	}
	if err := m.wifi.SetEnabled(on); err != nil {
		return WifiState{}, err
	}
	st, err := m.wifi.Get()
	if err != nil {
		return WifiState{}, err
	}
	m.updateSection("wifi", m.stateWifiSlot, st)
	return st, nil
}

// WifiNetworks triggers a scan (~2 s) and returns the networks.
func (m *Module) WifiNetworks() ([]WifiNetwork, error) {
	if m.wifi == nil {
		return nil, errUnsupported
	}
	return m.wifi.Scan()
}

// WifiConnect connects to a network. psk is only needed if the network is
// secured and not yet saved.
func (m *Module) WifiConnect(ssid, psk string) error {
	if m.wifi == nil || !m.wifi.CanConnect() {
		return errUnsupported
	}
	if err := m.wifi.Connect(ssid, psk); err != nil {
		return err
	}
	if st, err := m.wifi.Get(); err == nil {
		m.updateSection("wifi", m.stateWifiSlot, st)
	}
	return nil
}

func (m *Module) SetBluetoothEnabled(on bool) (BluetoothState, error) {
	if m.bluetooth == nil || !m.bluetooth.CanSet() {
		return BluetoothState{}, errUnsupported
	}
	if err := m.bluetooth.SetEnabled(on); err != nil {
		return BluetoothState{}, err
	}
	st, err := m.bluetooth.Get()
	if err != nil {
		return BluetoothState{}, err
	}
	m.updateSection("bluetooth", m.stateBluetoothSlot, st)
	return st, nil
}

func (m *Module) BluetoothDevices() ([]BluetoothDevice, error) {
	if m.bluetooth == nil {
		return nil, errUnsupported
	}
	return m.bluetooth.Devices()
}

func (m *Module) BluetoothConnect(address string, disconnect bool) error {
	if m.bluetooth == nil || !m.bluetooth.CanSet() {
		return errUnsupported
	}
	if err := m.bluetooth.Connect(address, disconnect); err != nil {
		return err
	}
	if st, err := m.bluetooth.Get(); err == nil {
		m.updateSection("bluetooth", m.stateBluetoothSlot, st)
	}
	return nil
}

// refresh reads all providers and records changes as dirty.
// Provider errors are transient (the section keeps its last value) —
// a dying pipewire should not drive the daemon into error spam.
func (m *Module) refresh() {
	if m.audio != nil {
		if st, err := m.audio.Get(); err == nil {
			m.updateSection("audio", m.stateAudioSlot, st)
		}
	}
	if m.brightness != nil {
		if st, err := m.brightness.Get(); err == nil {
			m.updateSection("brightness", m.stateBrightnessSlot, st)
		}
	}
	if m.battery != nil {
		if st, err := m.battery.Get(); err == nil {
			m.updateSection("battery", m.stateBatterySlot, st)
		}
	}
	if m.storage != nil {
		if st, err := m.storage.Get(); err == nil {
			m.updateSection("storage", m.stateStorageSlot, st)
		}
	}
	if m.mic != nil {
		if st, err := m.mic.Get(); err == nil {
			m.updateSection("mic", m.stateMicSlot, st)
		}
	}
	if m.privacy != nil {
		if st, err := m.privacy.Get(); err == nil {
			m.updateSection("privacy", m.statePrivacySlot, st)
		}
	}
	if m.wifi != nil {
		if st, err := m.wifi.Get(); err == nil {
			m.updateSection("wifi", m.stateWifiSlot, st)
		}
		// Session was locked/switched => polkit now says no. The UI then hides the
		// switch instead of letting it run into nothing (the provider caches the
		// answer).
		m.setDynamicCap("wifi.set", m.wifi.CanSet())
		m.setDynamicCap("wifi.connect", m.wifi.CanConnect())
	}
	if m.bluetooth != nil {
		if st, err := m.bluetooth.Get(); err == nil {
			m.updateSection("bluetooth", m.stateBluetoothSlot, st)
		}
	}
}

// setDynamicCap switches a capability on or off at runtime. The list is
// REBUILT rather than modified: State() hands out the slice, and a later
// append to it would be a data race.
func (m *Module) setDynamicCap(name string, on bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	has := false
	for _, c := range m.caps {
		if c == name {
			has = true
			break
		}
	}
	if has == on {
		return
	}
	next := make([]string, 0, len(m.caps)+1)
	for _, c := range m.caps {
		if c != name {
			next = append(next, c)
		}
	}
	if on {
		next = append(next, name)
	}
	m.caps = next
}

// The four slot adapters give updateSection a uniform write location, without
// reflection over the state struct.
func (m *Module) stateAudioSlot(v any) bool {
	st := v.(AudioState)
	if m.state.Audio != nil && *m.state.Audio == st {
		return false
	}
	m.state.Audio = &st
	return true
}

func (m *Module) stateBrightnessSlot(v any) bool {
	st := v.(BrightnessState)
	if m.state.Brightness != nil && *m.state.Brightness == st {
		return false
	}
	m.state.Brightness = &st
	return true
}

func (m *Module) stateBatterySlot(v any) bool {
	st := v.(BatteryState)
	if m.state.Battery != nil && reflect.DeepEqual(*m.state.Battery, st) {
		return false
	}
	m.state.Battery = &st
	return true
}

func (m *Module) stateStorageSlot(v any) bool {
	st := v.([]MountState)
	if m.state.Storage != nil && reflect.DeepEqual(m.state.Storage, st) {
		return false
	}
	m.state.Storage = st
	return true
}

func (m *Module) stateMicSlot(v any) bool {
	st := v.(MicState)
	if m.state.Mic != nil && *m.state.Mic == st {
		return false
	}
	m.state.Mic = &st
	return true
}

func (m *Module) stateWifiSlot(v any) bool {
	st := v.(WifiState)
	if m.state.Wifi != nil && *m.state.Wifi == st {
		return false
	}
	m.state.Wifi = &st
	return true
}

func (m *Module) stateBluetoothSlot(v any) bool {
	st := v.(BluetoothState)
	if m.state.Bluetooth != nil && reflect.DeepEqual(*m.state.Bluetooth, st) {
		return false
	}
	m.state.Bluetooth = &st
	return true
}

func (m *Module) statePrivacySlot(v any) bool {
	st := v.(PrivacyState)
	if m.state.Privacy != nil && reflect.DeepEqual(*m.state.Privacy, st) {
		return false
	}
	m.state.Privacy = &st
	return true
}

func (m *Module) updateSection(name string, slot func(any) bool, v any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !slot(v) {
		return
	}
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	m.dirty[name] = data
}

// flushDirty reports collected changes — at most every 500 ms per tick.
func (m *Module) flushDirty() {
	m.mu.Lock()
	if len(m.dirty) == 0 {
		m.mu.Unlock()
		return
	}
	batch := m.dirty
	m.dirty = map[string]json.RawMessage{}
	m.mu.Unlock()
	if m.emit == nil {
		return
	}
	for section, data := range batch {
		m.emit(ChangedEvent{Section: section, State: data})
	}
}

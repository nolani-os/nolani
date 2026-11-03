//go:build windows

package devicecontrol

// Windows audio: volume, mute, microphone and device selection via WASAPI.
// Counterpart to audio_linux.go/pactl_linux.go.
//
// The endpoint work lives in wasapi_windows.go; only the three providers the
// contract requires are here.

type winAudio struct{ w *comWorker }
type winMic struct{ w *comWorker }
type winAudioDevices struct{ w *comWorker }

// ── Volume (default output device) ─────────────────────────────────────────

func (a *winAudio) Probe() bool {
	return a.w.do(func() error {
		_, _, _, err := readEndpoint(wcaRender)
		return err
	}) == nil
}

func (a *winAudio) CanSet() bool { return true }

func (a *winAudio) Get() (AudioState, error) {
	var st AudioState
	err := a.w.do(func() error {
		name, vol, muted, err := readEndpoint(wcaRender)
		if err != nil {
			return err
		}
		st = AudioState{Volume: vol, Muted: muted, Sink: name}
		return nil
	})
	return st, err
}

func (a *winAudio) Set(volume *int, muted *bool) error {
	if volume != nil && (*volume < 0 || *volume > 100) {
		return badInput("volume muss 0..100 sein")
	}
	return a.w.do(func() error { return writeEndpoint(wcaRender, volume, muted) })
}

// ── Microphone (default capture device) ────────────────────────────────────

func (m *winMic) Probe() bool {
	return m.w.do(func() error {
		_, _, _, err := readEndpoint(eCapture)
		return err
	}) == nil
}

func (m *winMic) CanSet() bool { return true }

func (m *winMic) Get() (MicState, error) {
	var st MicState
	err := m.w.do(func() error {
		name, vol, muted, err := readEndpoint(eCapture)
		if err != nil {
			return err
		}
		st = MicState{Muted: muted, Volume: vol, Source: name}
		return nil
	})
	return st, err
}

func (m *winMic) Set(muted *bool, volume *int) error {
	if volume != nil && (*volume < 0 || *volume > 100) {
		return badInput("volume muss 0..100 sein")
	}
	return m.w.do(func() error { return writeEndpoint(eCapture, volume, muted) })
}

// ── Device selection ───────────────────────────────────────────────────────

func (d *winAudioDevices) Probe() bool {
	return d.w.do(func() error {
		_, err := listEndpoints()
		return err
	}) == nil
}

// CanSetDefault depends on the undocumented IPolicyConfig — hence probed and
// not assumed (see wasapi_windows.go).
func (d *winAudioDevices) CanSetDefault() bool {
	ok := false
	_ = d.w.do(func() error {
		ok = policyConfigAvailable()
		return nil
	})
	return ok
}

func (d *winAudioDevices) List() ([]AudioDevice, error) {
	var out []AudioDevice
	err := d.w.do(func() error {
		list, err := listEndpoints()
		if err != nil {
			return err
		}
		out = list
		return nil
	})
	return out, err
}

func (d *winAudioDevices) SetDefault(kind, id string) error {
	if kind != "sink" && kind != "source" {
		return badInput("kind muss sink oder source sein")
	}
	return d.w.do(func() error {
		// 🔑 As on Linux, check against the OWN list: an unplugged headphone then
		// yields a clear 400 instead of an HRESULT as 502.
		devs, err := listEndpoints()
		if err != nil {
			return err
		}
		for _, dev := range devs {
			if dev.Kind == kind && dev.ID == id {
				return setDefaultEndpoint(id)
			}
		}
		return badInput("unbekanntes Audiogeraet: " + id)
	})
}

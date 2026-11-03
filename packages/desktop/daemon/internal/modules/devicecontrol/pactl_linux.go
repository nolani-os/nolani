//go:build linux

package devicecontrol

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Audio device selection and microphone via pactl.
//
// 🔑 Why pactl and not wpctl (which the volume provider uses): for LISTS you
// need structure, not prose. `pactl -f json` delivers exactly that —
// `wpctl status` would mean parsing text with tree characters, which breaks on
// every formatting change. Test fixtures come from real pactl 17 output, not
// from the docs.
//
// On the target laptop pipewire-pulse provides the same pactl — if it is
// missing, the caps `audio.devices` and `mic` are simply absent (clean
// degradation, not an error).

type pactlDevices struct{}
type pactlMic struct{}

const (
	defaultSourceRef = "@DEFAULT_SOURCE@"
	defaultSinkRef   = "@DEFAULT_SINK@"
)

// ── pactl basics ───────────────────────────────────────────────────────────

type paVolumeChannel struct {
	ValuePercent string `json:"value_percent"` // e.g. "62%"
}

type paDevice struct {
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	Mute        bool                       `json:"mute"`
	Volume      map[string]paVolumeChannel `json:"volume"`
	Properties  map[string]any             `json:"properties"`
}

type paInfo struct {
	DefaultSinkName   string `json:"default_sink_name"`
	DefaultSourceName string `json:"default_source_name"`
}

func pactlJSON(out any, args ...string) error {
	full := append([]string{"-f", "json"}, args...)
	raw, err := exec.Command("pactl", full...).Output()
	if err != nil {
		return fmt.Errorf("pactl %s: %w", strings.Join(args, " "), err)
	}
	return json.Unmarshal(raw, out)
}

// isMonitor: capture sources that only record the output ("Monitor of …").
// They don't belong in a microphone selection — otherwise the user
// accidentally picks their own speaker as the microphone.
func (d paDevice) isMonitor() bool {
	if c, ok := d.Properties["device.class"].(string); ok && c == "monitor" {
		return true
	}
	return strings.HasSuffix(d.Name, ".monitor")
}

// volumePercent: loudest channel value ("62%" -> 62). pactl returns one value
// per channel; the UI shows one slider.
func (d paDevice) volumePercent() int {
	best := 0
	for _, ch := range d.Volume {
		v, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(ch.ValuePercent), "%"))
		if err == nil && v > best {
			best = v
		}
	}
	return best
}

func paDefaults() (paInfo, error) {
	var info paInfo
	err := pactlJSON(&info, "info")
	return info, err
}

// ── Microphone ─────────────────────────────────────────────────────────────

func (m *pactlMic) Probe() bool {
	_, err := paDefaults()
	return err == nil
}

func (m *pactlMic) CanSet() bool { return true }

func (m *pactlMic) Get() (MicState, error) {
	info, err := paDefaults()
	if err != nil {
		return MicState{}, err
	}
	var sources []paDevice
	if err := pactlJSON(&sources, "list", "sources"); err != nil {
		return MicState{}, err
	}
	for _, s := range sources {
		if s.Name != info.DefaultSourceName {
			continue
		}
		return MicState{
			Muted:  s.Mute,
			Volume: s.volumePercent(),
			Source: s.Description,
		}, nil
	}
	// No default capture device (machine without microphone): no section.
	return MicState{}, errUnsupported
}

func (m *pactlMic) Set(muted *bool, volume *int) error {
	if muted != nil {
		arg := "0"
		if *muted {
			arg = "1"
		}
		if out, err := exec.Command("pactl", "set-source-mute", defaultSourceRef, arg).
			CombinedOutput(); err != nil {
			return fmt.Errorf("pactl set-source-mute: %s", strings.TrimSpace(string(out)))
		}
	}
	if volume != nil {
		if out, err := exec.Command("pactl", "set-source-volume", defaultSourceRef,
			strconv.Itoa(*volume)+"%").CombinedOutput(); err != nil {
			return fmt.Errorf("pactl set-source-volume: %s", strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// ── Device selection ───────────────────────────────────────────────────────

func (p *pactlDevices) Probe() bool {
	_, err := paDefaults()
	return err == nil
}

// CanSetDefault: pactl can always set the default device when it is running —
// unlike Windows, where switching depends on an undocumented interface.
func (p *pactlDevices) CanSetDefault() bool { return true }

func (p *pactlDevices) List() ([]AudioDevice, error) {
	info, err := paDefaults()
	if err != nil {
		return nil, err
	}
	out := []AudioDevice{}
	add := func(kind, defName string, list []paDevice) {
		for _, d := range list {
			if kind == "source" && d.isMonitor() {
				continue
			}
			name := d.Description
			if name == "" {
				name = d.Name
			}
			out = append(out, AudioDevice{
				ID:      d.Name,
				Name:    name,
				Kind:    kind,
				Default: d.Name == defName,
			})
		}
	}
	var sinks, sources []paDevice
	if err := pactlJSON(&sinks, "list", "sinks"); err != nil {
		return nil, err
	}
	add("sink", info.DefaultSinkName, sinks)
	// The capture side is optional: a machine without a microphone should still
	// offer its output devices.
	if err := pactlJSON(&sources, "list", "sources"); err == nil {
		add("source", info.DefaultSourceName, sources)
	}
	return out, nil
}

func (p *pactlDevices) SetDefault(kind, id string) error {
	if kind != "sink" && kind != "source" {
		return badInput("kind muss sink oder source sein")
	}
	// 🔑 Check against our own list instead of passing the identifier through:
	// that way an unplugged headphone gives the user a clear 400 instead of a
	// cryptic pactl message as 502.
	devs, err := p.List()
	if err != nil {
		return err
	}
	found := false
	for _, d := range devs {
		if d.Kind == kind && d.ID == id {
			found = true
			break
		}
	}
	if !found {
		return badInput("unbekanntes Audiogeraet: " + id)
	}
	cmd := "set-default-sink"
	if kind == "source" {
		cmd = "set-default-source"
	}
	if out, err := exec.Command("pactl", cmd, id).CombinedOutput(); err != nil {
		return fmt.Errorf("pactl %s: %s", cmd, strings.TrimSpace(string(out)))
	}
	return nil
}

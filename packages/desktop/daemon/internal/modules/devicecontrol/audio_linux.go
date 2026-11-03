//go:build linux

package devicecontrol

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// wpctlAudio controls the default sink via wpctl (PipeWire, the default on
// current KDE distributions). The pactl fallback covers pure PulseAudio
// systems. Deliberately shelling out instead of a native protocol: wpctl is
// always present on the target system, and the output format
// "Volume: 0.55 [MUTED]" is locale-stable.
type wpctlAudio struct {
	tool string // "wpctl" | "pactl"
}

const wpctlSink = "@DEFAULT_AUDIO_SINK@"

func (a *wpctlAudio) Probe() bool {
	if _, err := exec.LookPath("wpctl"); err == nil {
		if _, err := exec.Command("wpctl", "get-volume", wpctlSink).Output(); err == nil {
			a.tool = "wpctl"
			return true
		}
	}
	if _, err := exec.LookPath("pactl"); err == nil {
		if _, err := exec.Command("pactl", "get-sink-volume", "@DEFAULT_SINK@").Output(); err == nil {
			a.tool = "pactl"
			return true
		}
	}
	return false
}

func (a *wpctlAudio) CanSet() bool { return true }

func (a *wpctlAudio) Get() (AudioState, error) {
	if a.tool == "pactl" {
		return a.getPactl()
	}
	// "Volume: 0.55" or "Volume: 0.55 [MUTED]"
	out, err := exec.Command("wpctl", "get-volume", wpctlSink).Output()
	if err != nil {
		return AudioState{}, fmt.Errorf("wpctl get-volume: %w", err)
	}
	s := strings.TrimSpace(string(out))
	st := AudioState{Muted: strings.Contains(s, "[MUTED]")}
	fields := strings.Fields(s)
	if len(fields) >= 2 {
		if f, err := strconv.ParseFloat(fields[1], 64); err == nil {
			st.Volume = int(f*100 + 0.5)
		}
	}
	st.Sink = a.sinkDescription()
	return st, nil
}

// sinkDescription: human-readable name of the default sink (best effort).
func (a *wpctlAudio) sinkDescription() string {
	out, err := exec.Command("wpctl", "inspect", wpctlSink).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if idx := strings.Index(line, "node.description = \""); idx >= 0 {
			rest := line[idx+len("node.description = \""):]
			if end := strings.Index(rest, "\""); end >= 0 {
				return rest[:end]
			}
		}
	}
	return ""
}

func (a *wpctlAudio) Set(volume *int, muted *bool) error {
	if a.tool == "pactl" {
		return a.setPactl(volume, muted)
	}
	if volume != nil {
		arg := strconv.FormatFloat(float64(*volume)/100.0, 'f', 2, 64)
		if out, err := exec.Command("wpctl", "set-volume", wpctlSink, arg).CombinedOutput(); err != nil {
			return fmt.Errorf("wpctl set-volume: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	if muted != nil {
		arg := "0"
		if *muted {
			arg = "1"
		}
		if out, err := exec.Command("wpctl", "set-mute", wpctlSink, arg).CombinedOutput(); err != nil {
			return fmt.Errorf("wpctl set-mute: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// ── pactl-Fallback ──────────────────────────────────────────────────────────

func (a *wpctlAudio) getPactl() (AudioState, error) {
	st := AudioState{}
	// "Volume: front-left: 36700 /  56% / ..." — take the first percentage field.
	out, err := exec.Command("pactl", "get-sink-volume", "@DEFAULT_SINK@").Output()
	if err != nil {
		return st, fmt.Errorf("pactl get-sink-volume: %w", err)
	}
	for _, f := range strings.Fields(string(out)) {
		if strings.HasSuffix(f, "%") {
			if v, err := strconv.Atoi(strings.TrimSuffix(f, "%")); err == nil {
				st.Volume = v
				break
			}
		}
	}
	if out, err := exec.Command("pactl", "get-sink-mute", "@DEFAULT_SINK@").Output(); err == nil {
		// locale-independent: "yes"/"ja" — pactl always prints "yes|no" here
		st.Muted = strings.Contains(strings.ToLower(string(out)), "yes")
	}
	return st, nil
}

func (a *wpctlAudio) setPactl(volume *int, muted *bool) error {
	if volume != nil {
		if out, err := exec.Command("pactl", "set-sink-volume", "@DEFAULT_SINK@",
			strconv.Itoa(*volume)+"%").CombinedOutput(); err != nil {
			return fmt.Errorf("pactl set-sink-volume: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	if muted != nil {
		arg := "0"
		if *muted {
			arg = "1"
		}
		if out, err := exec.Command("pactl", "set-sink-mute", "@DEFAULT_SINK@", arg).CombinedOutput(); err != nil {
			return fmt.Errorf("pactl set-sink-mute: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

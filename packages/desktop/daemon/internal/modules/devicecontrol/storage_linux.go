//go:build linux

package devicecontrol

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// procStorage: real storage devices from /proc/self/mounts + Statfs.
// Deliberately WITHOUT UDisks2: the heuristic "/media|/run/media = removable"
// covers the everyday case (USB stick) without another D-Bus surface.
type procStorage struct{}

func (s *procStorage) Probe() bool {
	_, err := os.ReadFile("/proc/self/mounts")
	return err == nil
}

func (s *procStorage) Get() ([]MountState, error) {
	data, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	var out []MountState
	seen := map[string]bool{} // only the first mount per block device (btrfs subvolumes!)
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		dev, mnt, fstype := f[0], f[1], f[2]
		if !strings.HasPrefix(dev, "/dev/") || fstype == "squashfs" ||
			strings.HasPrefix(dev, "/dev/loop") || seen[dev] {
			continue // drop snaps & duplicates
		}
		var st unix.Statfs_t
		if err := unix.Statfs(mnt, &st); err != nil || st.Blocks == 0 {
			continue
		}
		seen[dev] = true
		total := float64(st.Blocks) * float64(st.Bsize) / 1e9
		free := float64(st.Bavail) * float64(st.Bsize) / 1e9
		m := MountState{
			Mount:     mnt,
			TotalGB:   round1(total),
			FreeGB:    round1(free),
			Removable: strings.HasPrefix(mnt, "/media/") || strings.HasPrefix(mnt, "/run/media/"),
		}
		switch {
		case mnt == "/":
			m.Label = "System"
		default:
			// Mount point name as label; for removable media that is the volume name
			// assigned by the automounter.
			m.Label = filepath.Base(mnt)
		}
		out = append(out, m)
	}
	return out, nil
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

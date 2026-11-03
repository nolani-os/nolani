package devicecontrol

// Evaluation for the privacy indicator ("who is using the camera and
// microphone right now?"). Deliberately without a build tag and without
// registry access, so the rules are testable on the Linux build host — the
// Windows side only supplies the raw values (privacy_windows.go).

import (
	"path/filepath"
	"sort"
	"strings"
)

// privacyEntry is a raw value from Windows' ConsentStore: an application
// key plus the two timestamps Windows keeps there.
type privacyEntry struct {
	Key   string // registry key, e.g. "C:#Users#…#Discord.exe"
	Start uint64 // LastUsedTimeStart (FILETIME)
	Stop  uint64 // LastUsedTimeStop  (FILETIME); 0 = still running
}

// inUse: Windows marks an ongoing use by leaving the stop timestamp at 0
// while start is set. Measured in BOTH directions: while a program held the
// microphone open, 0 was there; after closing, a timestamp immediately.
//
// 🔑 Both conditions are needed. An entry without start is a mere permission
// note ("may use the mic"), not a use — anyone checking only `Stop == 0`
// reports every application that ever asked as active.
func (e privacyEntry) inUse() bool { return e.Stop == 0 && e.Start > 0 }

// appDisplayName turns a registry key into something presentable.
//
// 🔑 Why at all: the key is either a path with `#` instead of `\`
// ("C:#Program Files#Mozilla Firefox#firefox.exe") or a package name
// ("MSTeams_8wekyb3d8bbwe"). Neither belongs in a UI — the path is noise and
// reveals more about the machine than necessary.
func appDisplayName(key string) string {
	name := strings.ReplaceAll(key, "#", `\`)

	// Path -> file name without extension.
	if strings.Contains(name, `\`) {
		base := name[strings.LastIndex(name, `\`)+1:]
		base = strings.TrimSuffix(base, filepath.Ext(base))
		if base != "" {
			return base
		}
	}
	// Package name "Name_publisherhash" -> Name.
	if i := strings.LastIndex(name, "_"); i > 0 {
		return name[:i]
	}
	return name
}

// summarizeUse summarises the raw values of one kind (microphone or camera).
// Only applications accessing RIGHT NOW are named — history is the operating
// system's business, not this indicator's.
func summarizeUse(entries []privacyEntry) PrivacyUse {
	seen := map[string]bool{}
	apps := []string{}
	for _, e := range entries {
		if !e.inUse() {
			continue
		}
		n := appDisplayName(e.Key)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		apps = append(apps, n)
	}
	// Stable order: otherwise the row jumps on every poll pass, because the
	// registry promises no ordering.
	sort.Strings(apps)
	return PrivacyUse{InUse: len(apps) > 0, Apps: apps}
}

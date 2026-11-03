//go:build windows

package devicecontrol

// Privacy indicator on Windows: who is using the microphone or camera right
// now?
//
// 🔑 Windows keeps track of this itself — in the registry's ConsentStore, per
// application, with `LastUsedTimeStart`/`LastUsedTimeStop`. That is exactly
// what feeds Windows' own taskbar icon. No admin, no driver, no querying of
// running processes.
//
// Measured in BOTH directions before a line of this was written: while a
// program held the microphone open, an entry with `Stop = 0` appeared; after
// closing, a timestamp immediately. Without the counter-check it would have
// been impossible to tell whether every entry simply sits there.

import (
	"golang.org/x/sys/windows/registry"
)

const consentStore = `SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore`

type winPrivacy struct{}

// Probe: it suffices that the ConsentStore is readable. If it is missing
// (older Windows versions), the cap is absent — instead of a row that always says "no".
func (p *winPrivacy) Probe() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, consentStore, registry.READ)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

func (p *winPrivacy) Get() (PrivacyState, error) {
	st := PrivacyState{}
	if use, ok := readConsent("microphone"); ok {
		st.Mic = &use
	}
	// 🔑 Report the camera only if Windows keeps that branch at all. A desktop
	// machine without a camera thus gets no dead row.
	if use, ok := readConsent("webcam"); ok {
		st.Camera = &use
	}
	return st, nil
}

// readConsent reads a branch of the ConsentStore. The second return value is
// false if the branch doesn't exist.
func readConsent(kind string) (PrivacyUse, bool) {
	root, err := registry.OpenKey(registry.CURRENT_USER, consentStore+`\`+kind, registry.READ|registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return PrivacyUse{}, false
	}
	defer root.Close()

	names, err := root.ReadSubKeyNames(-1)
	if err != nil {
		return PrivacyUse{}, false
	}

	entries := []privacyEntry{}
	for _, name := range names {
		// 🔑 Two levels: Store apps are listed directly, classic programs below
		// them in `NonPackaged`. Forget the sub-branch and you never see
		// Discord and Firefox — i.e. almost everything that matters here.
		if name == "NonPackaged" {
			sub, err := registry.OpenKey(root, name, registry.READ|registry.ENUMERATE_SUB_KEYS)
			if err != nil {
				continue
			}
			subNames, err := sub.ReadSubKeyNames(-1)
			if err == nil {
				for _, sn := range subNames {
					if e, ok := readEntry(sub, sn); ok {
						entries = append(entries, e)
					}
				}
			}
			sub.Close()
			continue
		}
		if e, ok := readEntry(root, name); ok {
			entries = append(entries, e)
		}
	}
	return summarizeUse(entries), true
}

func readEntry(parent registry.Key, name string) (privacyEntry, bool) {
	k, err := registry.OpenKey(parent, name, registry.QUERY_VALUE)
	if err != nil {
		return privacyEntry{}, false
	}
	defer k.Close()
	// Missing values are normal (a mere permission note) and yield 0 —
	// `inUse()` requires a set start so this doesn't become a false alarm.
	start, _, _ := k.GetIntegerValue("LastUsedTimeStart")
	stop, _, _ := k.GetIntegerValue("LastUsedTimeStop")
	return privacyEntry{Key: name, Start: start, Stop: stop}, true
}

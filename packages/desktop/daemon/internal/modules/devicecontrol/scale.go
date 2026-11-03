package devicecontrol

// Conversion between the contract's percentage scale (0..100, what the shell
// displays) and the operating systems' scalar scale (0.0..1.0, what WASAPI
// expects).
//
// Deliberately platform-neutral and without a build tag: that way the test
// also runs on the Linux build host — the Windows code itself is not testable
// anywhere here, because it needs real devices.

// pctFromScalar rounds half up and clamps to 0..100.
// 🔑 Round, don't truncate: 0.3 comes back from WASAPI as 0.29999998, an int
// cast turned that into 29 — the slider would jump back one point after every
// set.
func pctFromScalar(level float32) int {
	pct := int(float64(level)*100 + 0.5)
	return clampPct(pct)
}

// scalarFromPct is the reverse direction.
func scalarFromPct(pct int) float32 {
	return float32(clampPct(pct)) / 100
}

func clampPct(pct int) int {
	if pct < 0 {
		return 0
	}
	if pct > 100 {
		return 100
	}
	return pct
}

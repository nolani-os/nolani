package devicecontrol

import "testing"

func TestPctFromScalar(t *testing.T) {
	cases := []struct {
		name  string
		level float32
		want  int
	}{
		{"stumm", 0, 0},
		{"voll", 1, 100},
		// The actual reason for this file: WASAPI does not return set values
		// exactly. 0.3 becomes 0.29999998 — an int cast yields 29, the slider jumps
		// back.
		{"WASAPI-Rueckgabe fuer 30 %", 0.29999998, 30},
		{"WASAPI-Rueckgabe fuer 67 %", 0.6700000167, 67},
		{"halb", 0.5, 50},
		{"unter Null geklemmt", -0.2, 0},
		{"ueber Eins geklemmt", 1.4, 100},
	}
	for _, c := range cases {
		if got := pctFromScalar(c.level); got != c.want {
			t.Errorf("%s: pctFromScalar(%v) = %d, erwartet %d", c.name, c.level, got, c.want)
		}
	}
}

func TestScalarFromPct(t *testing.T) {
	cases := []struct {
		pct  int
		want float32
	}{
		{0, 0}, {50, 0.5}, {100, 1},
		{-10, 0}, // out of range -> clamped, no error to the hardware
		{250, 1},
	}
	for _, c := range cases {
		if got := scalarFromPct(c.pct); got != c.want {
			t.Errorf("scalarFromPct(%d) = %v, erwartet %v", c.pct, got, c.want)
		}
	}
}

// Round-tripping must not shift the value — otherwise the slider drifts on
// every poll pass.
func TestRoundTripStabil(t *testing.T) {
	for pct := 0; pct <= 100; pct++ {
		if got := pctFromScalar(scalarFromPct(pct)); got != pct {
			t.Errorf("Rundlauf %d -> %v -> %d", pct, scalarFromPct(pct), got)
		}
	}
}

package provision

import "testing"

func TestNormalizeServer(t *testing.T) {
	saved := DirectDomain
	t.Cleanup(func() { DirectDomain = saved })

	DirectDomain = ""
	ok := map[string]string{
		"example.org":                    "https://home.example.org/",
		" Home.Example.org ":             "https://home.example.org/",
		"https://home.example.org/x/y":   "https://home.example.org/",
		"1-2-3-4.sslip.io":               "https://home.1-2-3-4.sslip.io/",
		"https://cell.example.net/login": "https://home.cell.example.net/",
	}
	for in, want := range ok {
		if got, err := NormalizeServer(in); err != nil || got != want {
			t.Errorf("NormalizeServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "http://example.org", "user@example.org", "example.org:8443",
		"10.0.0.5", "localhost", "a..org", "-a.org", "exa_mple.org"} {
		if got, err := NormalizeServer(in); err == nil {
			t.Errorf("NormalizeServer(%q) = %q, want error", in, got)
		}
	}

	DirectDomain = "example.org"
	if _, err := NormalizeServer("cell.example.org"); err != nil {
		t.Errorf("subdomain of the fixed domain rejected: %v", err)
	}
	if _, err := NormalizeServer("example.net"); err == nil {
		t.Error("foreign domain accepted although DirectDomain is set")
	}
}

func TestNormalizeControlURL(t *testing.T) {
	cases := map[string]string{
		"":                            DefaultControlURL,
		"hs.example.org/":             "https://hs.example.org",
		"https://hs.example.org:8443": "https://hs.example.org:8443",
	}
	for in, want := range cases {
		if got, err := NormalizeControlURL(in); err != nil || got != want {
			t.Errorf("NormalizeControlURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"http://hs.example.org", "ftp://hs.example.org",
		"https://user@hs.example.org", "https://10.0.0.5"} {
		if got, err := NormalizeControlURL(in); err == nil {
			t.Errorf("NormalizeControlURL(%q) = %q, want error", in, got)
		}
	}
}

package tsnode

import "testing"

// tsnet's own resolver must ALWAYS be asked first: only it is reachable
// behind a commercial VPN (such VPNs enforce their own DNS and silently drop
// port 53 to any other destination).
func TestResolversFragtMagicDNSZuerst(t *testing.T) {
	n := New(t.TempDir(), "https://example.invalid", "testhost", "10.0.0.53:53")
	got := n.resolvers()
	if len(got) != 2 {
		t.Fatalf("zwei Resolver erwartet, bekommen: %v", got)
	}
	if got[0] != MagicDNSAddr {
		t.Errorf("erster Resolver = %q, erwartet %q", got[0], MagicDNSAddr)
	}
	if got[1] != "10.0.0.53:53" {
		t.Errorf("zweiter Resolver = %q, erwartet den aus dem Provisioning", got[1])
	}
}

// Without resolver_addr from provisioning the build's fallback applies — MagicDNS
// must still come first and nothing may appear twice. The fallback is a link-time
// variable, so the test sets it itself and covers the generic build (empty) too.
func TestResolversWithoutProvisioningValue(t *testing.T) {
	saved := FallbackResolverAddr
	t.Cleanup(func() { FallbackResolverAddr = saved })

	FallbackResolverAddr = "10.0.0.53:53"
	got := New(t.TempDir(), "https://example.invalid", "testhost", "").resolvers()
	if len(got) != 2 || got[0] != MagicDNSAddr || got[1] != "10.0.0.53:53" {
		t.Errorf("variant build: want [MagicDNS, fallback], got %v", got)
	}

	FallbackResolverAddr = ""
	got = New(t.TempDir(), "https://example.invalid", "testhost", "").resolvers()
	if len(got) != 1 || got[0] != MagicDNSAddr {
		t.Errorf("generic build: want only MagicDNS, got %v", got)
	}
}

// If provisioning happens to return MagicDNS itself, it must not appear twice
// in the list — otherwise every failure costs double the time.
func TestResolversKeineDublette(t *testing.T) {
	n := New(t.TempDir(), "https://example.invalid", "testhost", MagicDNSAddr)
	if got := n.resolvers(); len(got) != 1 {
		t.Errorf("genau ein Resolver erwartet, bekommen: %v", got)
	}
}

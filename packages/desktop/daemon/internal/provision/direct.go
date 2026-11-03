package provision

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

// DirectDomain limits direct connections to one domain and its subdomains (a
// variant build with a fixed home domain sets it at link time). Empty in the
// generic build: any https server the user names.
var DirectDomain = ""

// DefaultControlURL is the coordination server used when the user asks for a
// tunnel but names none.
const DefaultControlURL = "https://controlplane.tailscale.com"

// ErrBadServer: the address is not an https host name (or, in a variant with a
// fixed domain, not under it).
var ErrBadServer = errors.New("connect: invalid server address")

// ErrBadControlURL: the coordination server is not an https URL with a host name.
var ErrBadControlURL = errors.New("connect: invalid coordination server")

// NormalizeServer turns "example.org", "home.example.org" or a full URL into the
// shell URL https://home.<domain>/. Never plain http, no user info, no port, no
// bare IP address.
func NormalizeServer(input string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(input))
	if s == "" || strings.HasPrefix(s, "http://") {
		return "", ErrBadServer
	}
	s = strings.TrimPrefix(s, "https://")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if strings.ContainsAny(s, ":@") || !isHostName(s) {
		return "", ErrBadServer
	}
	if !strings.HasPrefix(s, "home.") {
		s = "home." + s
	}
	domain := strings.TrimPrefix(s, "home.")
	if DirectDomain != "" && domain != DirectDomain && !strings.HasSuffix(domain, "."+DirectDomain) {
		return "", ErrBadServer
	}
	return "https://" + s + "/", nil
}

// NormalizeControlURL checks the coordination server for the optional tunnel:
// an https URL with a host name (port allowed); empty means DefaultControlURL.
// Returns it without trailing slash.
func NormalizeControlURL(input string) (string, error) {
	s := strings.TrimSpace(input)
	if s == "" {
		return DefaultControlURL, nil
	}
	if !strings.HasPrefix(strings.ToLower(s), "https://") {
		if strings.Contains(s, "://") {
			return "", ErrBadControlURL
		}
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || !strings.EqualFold(u.Scheme, "https") || u.User != nil ||
		!isHostName(strings.ToLower(u.Hostname())) {
		return "", ErrBadControlURL
	}
	return strings.TrimRight(s, "/"), nil
}

// isHostName: a DNS name with at least two labels — no bare IP, no empty labels.
func isHostName(s string) bool {
	if net.ParseIP(s) != nil {
		return false
	}
	labels := strings.Split(s, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 63 || strings.HasPrefix(l, "-") || strings.HasSuffix(l, "-") {
			return false
		}
		for _, c := range l {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

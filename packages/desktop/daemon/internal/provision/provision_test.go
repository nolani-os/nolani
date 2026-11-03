package provision

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The generic build knows no server. Pairing without one must fail clearly
// instead of sending the invite token to some built-in address.
func TestProvisionWithoutBackend(t *testing.T) {
	saved := DefaultBackend
	t.Cleanup(func() { DefaultBackend = saved })
	DefaultBackend = ""

	_, err := Provision(context.Background(), "", "token", "host")
	if !errors.Is(err, ErrNoBackend) {
		t.Fatalf("want ErrNoBackend, got %v", err)
	}
}

// The shell URL a server returns becomes the origin with IPC rights — anything but
// https with a host name is refused.
func TestProvisionRejectsUnsafeShellURL(t *testing.T) {
	answer := func(shell string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"shell_url":%q,"server_url":"https://hs.example.org","auth_key":"k"}`, shell)
		}))
	}
	for _, shell := range []string{
		"http://home.example.org/", "https://10.0.0.5/",
		"https://user@home.example.org/", "javascript:alert(1)",
	} {
		srv := answer(shell)
		_, err := Provision(context.Background(), srv.URL, "token", "host")
		srv.Close()
		if err == nil {
			t.Errorf("%s: accepted", shell)
		}
	}
	srv := answer("https://Home.Example.org/")
	defer srv.Close()
	if _, err := Provision(context.Background(), srv.URL, "token", "host"); err != nil {
		t.Fatalf("valid shell URL refused: %v", err)
	}
}

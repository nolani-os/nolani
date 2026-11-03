// Package provision: port of ProvisioningClient.java — ONE call fetches
// everything the app needs (shell_url, coordination server_url, 60-min preauth
// key, per-user service credentials). The auth_key is used by the caller and
// NEVER persisted (same discipline as Android).
package provision

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultBackend is the server the app pairs against when the caller names
// none. It must be reachable publicly, without tunnel or session — that is how
// the app gets its tunnel in the first place. Empty in the generic build (the
// user enters a server); a variant build sets it at link time:
//
//	go build -ldflags "-X <module>/internal/provision.DefaultBackend=https://…"
var DefaultBackend = ""

// ErrNoBackend: neither the caller nor the build named a server to pair with.
var ErrNoBackend = errors.New("app-provision: no server configured")

// Response = response of POST /api/claraos/onboarding/app-provision
// (packages/api/routers/onboarding_public.py).
type Response struct {
	ShellURL     string `json:"shell_url"`
	ServerURL    string `json:"server_url"`
	AuthKey      string `json:"auth_key"`
	DisplayName  string `json:"display_name"`
	ResolverAddr string `json:"resolver_addr"` // empty on older servers

	NtfyServer string `json:"ntfy_server"`
	NtfyTopic  string `json:"ntfy_topic"`
	NtfyAuth   string `json:"ntfy_auth"`

	ImmichURL      string `json:"immich_url"`
	ImmichAPIKey   string `json:"immich_api_key"`
	PaperlessURL   string `json:"paperless_url"`
	PaperlessToken string `json:"paperless_token"`
}

// Error types for the UI (the app writes the messages, not the daemon).
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("app-provision: HTTP %d: %s", e.Status, e.Body)
}

// Provision calls app-provision. token = invite token (from deep link or
// paste), deviceName = the device's tsnet host name.
func Provision(ctx context.Context, backend, token, deviceName string) (*Response, error) {
	if backend == "" {
		backend = DefaultBackend
	}
	if backend == "" {
		return nil, ErrNoBackend
	}
	body, _ := json.Marshal(map[string]string{
		"token":       token,
		"device_name": deviceName,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		backend+"/api/claraos/onboarding/app-provision", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, &HTTPError{Status: resp.StatusCode, Body: string(raw)}
	}
	var r Response
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	if r.ShellURL == "" || r.ServerURL == "" || r.AuthKey == "" {
		return nil, fmt.Errorf("app-provision: unvollständige Antwort")
	}
	// The shell URL becomes the origin that gets IPC and device events: https with a
	// host name only, whatever the server answered.
	if u, err := url.Parse(r.ShellURL); err != nil || u.Scheme != "https" || !isHostName(strings.ToLower(u.Hostname())) || u.User != nil {
		return nil, fmt.Errorf("app-provision: shell_url nicht erlaubt")
	}
	return &r, nil
}

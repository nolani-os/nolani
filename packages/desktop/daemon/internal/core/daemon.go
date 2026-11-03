// Package core: clarad's state machine — connects provisioning, tsnode and the
// control API. The module registry hooks in here.
package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"claraos.de/companion/clarad/internal/modules"
	"claraos.de/companion/clarad/internal/modules/devicecontrol"
	"claraos.de/companion/clarad/internal/modules/foldersync"
	"claraos.de/companion/clarad/internal/modules/ntfypush"
	"claraos.de/companion/clarad/internal/provision"
	"claraos.de/companion/clarad/internal/state"
	"claraos.de/companion/clarad/internal/tsnode"
)

// States (protocol/control-api.md).
const (
	StateUnprovisioned = "unprovisioned"
	StateStarting      = "starting"
	StateConnecting    = "connecting"
	StateUp            = "up"
	StateDown          = "down"
	StateError         = "error"
)

type Status struct {
	State     string `json:"state"`
	SocksPort int    `json:"socks_port,omitempty"`
	Hostname  string `json:"hostname,omitempty"`
	ShellURL  string `json:"shell_url,omitempty"`
	Version   string `json:"version"`
	Error     string `json:"error,omitempty"`
	// Direct: connected without tunnel — the shell loads without proxy.
	Direct bool `json:"direct,omitempty"`
	// CanInvite: this build has a pairing server, so invitation codes work.
	CanInvite bool `json:"can_invite"`
	// Push: push credentials are configured (provisioned, or fetched once after login).
	Push bool `json:"push,omitempty"`
}

// Event is sent to the UI as SSE (`GET /v1/events`).
type Event struct {
	Type string          `json:"type"` // state.changed | notification | sync.progress | update.available | module.consent_request
	Data json.RawMessage `json:"data"`
}

type Daemon struct {
	Version string
	Paths   state.Paths

	mu        sync.Mutex
	cfg       *state.Config
	node      *tsnode.Node
	stateName string
	lastErr   string
	socksPort int

	subsMu sync.Mutex
	subs   map[chan Event]struct{}

	mods   *modules.Registry
	device *devicecontrol.Module
	ntfy   *ntfypush.Module // for swapping credentials without re-pairing

	quit chan struct{} // closed on shutdown → main exits
}

func NewDaemon(paths state.Paths, version string) (*Daemon, error) {
	cfg, err := state.LoadConfig(paths)
	if err != nil {
		return nil, err
	}
	st := StateUnprovisioned
	if cfg != nil {
		st = StateStarting
	}
	d := &Daemon{
		Version:   version,
		Paths:     paths,
		cfg:       cfg,
		stateName: st,
		subs:      map[chan Event]struct{}{},
		quit:      make(chan struct{}),
	}
	d.mods = modules.NewRegistry(func(info modules.Info) {
		data, _ := json.Marshal(info)
		d.Publish(Event{Type: "module.changed", Data: data})
	})
	// Remote control is planned but NOT built: visible as "unavailable" so it is
	// clear that nothing is running here yet.
	d.mods.RegisterPlaceholder("remote-desktop")

	// Device control: independent of the tunnel, starts immediately. Local device
	// control — reachable only via the control API, contract in
	// protocol/control-api.md.
	d.device = devicecontrol.New(func(ev devicecontrol.ChangedEvent) {
		data, _ := json.Marshal(ev)
		d.Publish(Event{Type: "device.changed", Data: data})
	})
	d.mods.Register(d.device)
	if err := d.mods.Start(d.device.ID()); err != nil {
		log.Printf("module %s: %v", d.device.ID(), err)
	}
	return d, nil
}

// Modules exposes the registry to the control API.
func (d *Daemon) Modules() *modules.Registry { return d.mods }

// Device exposes the device-control module to the control API.
func (d *Daemon) Device() *devicecontrol.Module { return d.device }

// startModules attaches the background services to the freshly established
// tunnel. Everything is opportunistic: if a service configuration is missing
// (e.g. the user has no ntfy), the module is simply left out.
func (d *Daemon) startModules() {
	d.mu.Lock()
	cfg, node := d.cfg, d.node
	d.mu.Unlock()
	if cfg == nil {
		return
	}
	dial := dialFor(cfg, node)
	if dial == nil {
		return
	}
	if cfg.NtfyServer != "" && cfg.NtfyTopic != "" {
		m := ntfypush.New(
			ntfypush.Config{Server: cfg.NtfyServer, Topic: cfg.NtfyTopic, Auth: cfg.NtfyAuth},
			dial,
			func(n ntfypush.Notification) {
				data, _ := json.Marshal(n)
				d.Publish(Event{Type: "notification", Data: data})
			},
		)
		// If ntfy rejects the credential, that is no reason to keep knocking forever
		// — the app is asked to obtain a fresh one (it has the signed-in session, the
		// daemon does not).
		m.SetAuthStaleHandler(func() {
			d.Publish(Event{Type: "push.auth-stale", Data: json.RawMessage(`{}`)})
		})
		d.mu.Lock()
		d.ntfy = m
		d.mu.Unlock()
		d.mods.Register(m)
		if err := d.mods.Start(m.ID()); err != nil {
			log.Printf("module %s: %v", m.ID(), err)
		}
	}

	// Folder sync: only with service credentials AND folders chosen by the user.
	// Without both nothing happens — nobody should see uploads they didn't ask for.
	devID := "desktop-" + cfg.Hostname
	emit := func(pr foldersync.Progress) {
		data, _ := json.Marshal(pr)
		d.Publish(Event{Type: "sync.progress", Data: data})
	}
	if cfg.ImmichURL != "" && cfg.ImmichAPIKey != "" &&
		cfg.Sync.Immich.Enabled && len(cfg.Sync.Immich.Folders) > 0 {
		m := foldersync.New(
			&foldersync.Immich{BaseURL: cfg.ImmichURL, APIKey: cfg.ImmichAPIKey},
			cfg.Sync.Immich.Folders, dial, devID,
			filepath.Join(d.Paths.DataDir, "cursor-immich.json"), emit)
		d.mods.Register(m)
		if err := d.mods.Start(m.ID()); err != nil {
			log.Printf("module %s: %v", m.ID(), err)
		}
	}
	if cfg.PaperlessURL != "" && cfg.PaperlessToken != "" &&
		cfg.Sync.Paperless.Enabled && len(cfg.Sync.Paperless.Folders) > 0 {
		m := foldersync.New(
			&foldersync.Paperless{BaseURL: cfg.PaperlessURL, Token: cfg.PaperlessToken},
			cfg.Sync.Paperless.Folders, dial, devID,
			filepath.Join(d.Paths.DataDir, "cursor-paperless.json"), emit)
		d.mods.Register(m)
		if err := d.mods.Start(m.ID()); err != nil {
			log.Printf("module %s: %v", m.ID(), err)
		}
	}
}

// SyncConfig returns the current folder configuration.
func (d *Daemon) SyncConfig() state.SyncConfig {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cfg == nil {
		return state.SyncConfig{}
	}
	return d.cfg.Sync
}

// SetSyncConfig stores the folder selection and restarts the sync modules so
// the change takes effect immediately (instead of at the next app start).
func (d *Daemon) SetSyncConfig(sc state.SyncConfig) error {
	d.mu.Lock()
	if d.cfg == nil {
		d.mu.Unlock()
		return errNotProvisioned
	}
	d.cfg.Sync = sc
	cfg := d.cfg
	d.mu.Unlock()
	if err := state.SaveConfig(d.Paths, cfg); err != nil {
		return err
	}
	d.mods.Stop("immich-sync")
	d.mods.Stop("paperless-sync")
	d.startModules()
	return nil
}

func (d *Daemon) Quit() <-chan struct{} { return d.quit }

func (d *Daemon) Status() Status {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.Statuslocked()
}

// isDirect: set up without tunnel (no coordination server stored).
func isDirect(cfg *state.Config) bool {
	return cfg != nil && cfg.ServerURL == ""
}

// Connect sets the device up by server address instead of an invitation: directly
// (controlURL and authKey empty — the shell is public, it handles login itself) or
// through a tunnel the user configures (any Tailscale-compatible coordination
// server; empty controlURL with an auth key = DefaultControlURL). The auth key is
// used once and never persisted.
func (d *Daemon) Connect(server, controlURL, authKey string) error {
	shellURL, err := provision.NormalizeServer(server)
	if err != nil {
		return err
	}
	osHost, _ := os.Hostname()
	cfg := &state.Config{ShellURL: shellURL, Hostname: state.NormalizeHostname(osHost)}
	tunnel := strings.TrimSpace(controlURL) != "" || strings.TrimSpace(authKey) != ""
	if tunnel {
		if strings.TrimSpace(authKey) == "" {
			return errNoAuthKey
		}
		if cfg.ServerURL, err = provision.NormalizeControlURL(controlURL); err != nil {
			return err
		}
	}
	d.mods.StopAll()
	d.mods.Start(d.device.ID()) //nolint:errcheck // device control does not depend on the tunnel
	d.mu.Lock()
	if d.node != nil {
		d.node.Close()
		d.node = nil
	}
	d.socksPort = 0
	d.mu.Unlock()
	if err := state.SaveConfig(d.Paths, cfg); err != nil {
		return err
	}
	d.mu.Lock()
	d.cfg = cfg
	d.mu.Unlock()
	if tunnel {
		d.startTunnelAsync(strings.TrimSpace(authKey))
	} else {
		d.setState(StateUp, "")
	}
	return nil
}

// Provision: invite token → app-provision → persist config (without auth_key)
// → bring the tunnel up with the key. Synchronous until the server responds;
// the tunnel setup runs asynchronously (progress via events).
func (d *Daemon) Provision(ctx context.Context, token, backend string) error {
	osHost, _ := os.Hostname()
	hostname := state.NormalizeHostname(osHost)
	resp, err := provision.Provision(ctx, backend, token, hostname)
	if err != nil {
		return err
	}
	cfg := &state.Config{
		ShellURL:     resp.ShellURL,
		ServerURL:    resp.ServerURL,
		ResolverAddr: resp.ResolverAddr,
		DisplayName:  resp.DisplayName,
		Hostname:     hostname,
		NtfyServer:   resp.NtfyServer, NtfyTopic: resp.NtfyTopic, NtfyAuth: resp.NtfyAuth,
		ImmichURL: resp.ImmichURL, ImmichAPIKey: resp.ImmichAPIKey,
		PaperlessURL: resp.PaperlessURL, PaperlessToken: resp.PaperlessToken,
	}
	if err := state.SaveConfig(d.Paths, cfg); err != nil {
		return err
	}
	d.mu.Lock()
	d.cfg = cfg
	d.mu.Unlock()
	d.startTunnelAsync(resp.AuthKey)
	return nil
}

// Up starts the tunnel from persisted state (normal case after app start).
func (d *Daemon) Up() error {
	d.mu.Lock()
	if d.cfg == nil {
		d.mu.Unlock()
		return errNotProvisioned
	}
	if d.stateName == StateUp || d.stateName == StateConnecting {
		d.mu.Unlock()
		return nil
	}
	direct := isDirect(d.cfg)
	d.mu.Unlock()
	if direct {
		d.setState(StateUp, "") // nothing to bring up: the shell is reached directly
		d.startModules()
		return nil
	}
	d.startTunnelAsync("")
	return nil
}

func (d *Daemon) startTunnelAsync(authKey string) {
	d.setState(StateConnecting, "")
	go func() {
		d.mu.Lock()
		cfg := d.cfg
		if d.node != nil {
			d.node.Close()
			d.node = nil
		}
		node := tsnode.New(d.Paths.TsnetDir(), cfg.ServerURL, cfg.Hostname, cfg.ResolverAddr)
		d.node = node
		d.mu.Unlock()

		if err := node.Start(context.Background(), authKey); err != nil {
			log.Printf("tsnode: Start fehlgeschlagen: %v", err)
			d.setState(StateError, err.Error())
			return
		}
		port, err := node.StartSocksProxy()
		if err != nil {
			log.Printf("tsnode: SOCKS-Proxy fehlgeschlagen: %v", err)
			d.setState(StateError, err.Error())
			return
		}
		d.mu.Lock()
		d.socksPort = port
		d.mu.Unlock()
		log.Printf("tsnode: tunnel up, SOCKS5 auf 127.0.0.1:%d", port)
		d.setState(StateUp, "")
		d.startModules()
	}()
}

func (d *Daemon) Down() error {
	// Modules first: they dial through the tunnel we are about to close.
	d.mods.StopAll()
	d.mu.Lock()
	if d.node != nil {
		d.node.Close()
		d.node = nil
	}
	d.socksPort = 0
	d.mu.Unlock()
	d.setState(StateDown, "")
	return nil
}

func (d *Daemon) Shutdown() {
	d.Down()
	close(d.quit)
}

func (d *Daemon) setState(name, errMsg string) {
	d.mu.Lock()
	d.stateName = name
	d.lastErr = errMsg
	st := d.Statuslocked()
	d.mu.Unlock()
	data, _ := json.Marshal(st)
	d.Publish(Event{Type: "state.changed", Data: data})
}

// statusLocked: status snapshot; caller already holds d.mu.
func (d *Daemon) Statuslocked() Status {
	s := Status{State: d.stateName, SocksPort: d.socksPort, Version: d.Version, Error: d.lastErr,
		CanInvite: provision.DefaultBackend != ""}
	if d.cfg != nil {
		s.Hostname = d.cfg.Hostname
		s.ShellURL = d.cfg.ShellURL
		s.Direct = isDirect(d.cfg)
		s.Push = d.cfg.NtfyServer != "" && d.cfg.NtfyTopic != ""
	}
	return s
}

// dialFor: how background modules reach the server — through the tunnel, or in a
// direct setup over the normal network. nil = no way (tunnel not up yet).
func dialFor(cfg *state.Config, node *tsnode.Node) func(context.Context, string, string) (net.Conn, error) {
	if node != nil {
		return node.Dial
	}
	if isDirect(cfg) {
		return (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	return nil
}

// Subscribe/Publish: minimal event hub for SSE.
func (d *Daemon) Subscribe() chan Event {
	ch := make(chan Event, 16)
	d.subsMu.Lock()
	d.subs[ch] = struct{}{}
	d.subsMu.Unlock()
	return ch
}

func (d *Daemon) Unsubscribe(ch chan Event) {
	d.subsMu.Lock()
	delete(d.subs, ch)
	d.subsMu.Unlock()
	close(ch)
}

func (d *Daemon) Publish(ev Event) {
	d.subsMu.Lock()
	defer d.subsMu.Unlock()
	for ch := range d.subs {
		select {
		case ch <- ev:
		default: // slow consumer: drop the event instead of blocking
		}
	}
}

type daemonError string

func (e daemonError) Error() string { return string(e) }

const errNoAuthKey = daemonError("tunnel: auth key missing")

const errNotProvisioned = daemonError("nicht provisioniert — zuerst /v1/provision aufrufen")

// RefreshPushCredential uses the app's session to fetch a fresh ntfy credential
// and installs it — without re-pairing.
//
// 🔴 The bug this fixes: ntfy issues tokens with a 72-hour lifetime, but the
// daemon only stored its token at pairing time. Three days later ntfy answered
// 401 permanently — thousands of log lines at a 64-second interval on one
// machine, with nothing ever healing. It could only be repaired by hand in the
// encrypted configuration.
//
// 🔑 Why the daemon fetches and not the app: the shell URL is only reachable
// inside the tailnet, and **the tunnel lives here**. The app merely supplies
// its WebView's session cookies — it is the only place that has a signed-in
// session. So no second secret is needed on the device and no new trust path
// on the server.
func (d *Daemon) RefreshPushCredential(ctx context.Context, cookies string) error {
	d.mu.Lock()
	cfg, node, mod := d.cfg, d.node, d.ntfy
	d.mu.Unlock()
	if cfg == nil || cfg.ShellURL == "" {
		return fmt.Errorf("nicht eingerichtet")
	}
	dial := dialFor(cfg, node)
	if dial == nil {
		return fmt.Errorf("Tunnel steht nicht")
	}
	// Without a module, push is only set up here in a direct setup (its first fetch
	// after login). A tunnel setup gets its push config from provisioning.
	if mod == nil && !isDirect(cfg) {
		return fmt.Errorf("Push ist nicht eingerichtet")
	}
	if cookies == "" {
		return fmt.Errorf("keine Sitzung uebergeben")
	}

	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{DialContext: dial},
		// Do NOT follow redirects: an expired session ends at the login page, and a
		// 200 with HTML would otherwise look like success.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	url := strings.TrimSuffix(cfg.ShellURL, "/") +
		"/api/claraos/ntfy/device-token?device=" + neturl.QueryEscape(cfg.Hostname)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Cookie", cookies)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Erneuerung abgelehnt: HTTP %d", resp.StatusCode)
	}
	var antwort struct {
		Auth   string `json:"auth"`
		Server string `json:"ntfy_server"`
		Topic  string `json:"ntfy_topic"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&antwort); err != nil {
		return err
	}
	if !strings.HasPrefix(antwort.Auth, "Bearer ") {
		return fmt.Errorf("Antwort enthaelt keinen Zugang")
	}

	d.mu.Lock()
	cfg.NtfyAuth = antwort.Auth
	if mod == nil {
		if antwort.Server == "" || antwort.Topic == "" {
			d.mu.Unlock()
			return fmt.Errorf("Server bietet keinen Push an")
		}
		cfg.NtfyServer, cfg.NtfyTopic = antwort.Server, antwort.Topic
	}
	d.mu.Unlock()
	if err := state.SaveConfig(d.Paths, cfg); err != nil {
		return err
	}
	if mod == nil {
		d.startModules()
		log.Printf("ntfy: Push nach der Anmeldung eingerichtet")
		return nil
	}
	mod.UpdateAuth(antwort.Auth)
	// Restart so the hanging stream reconnects immediately with the new
	// credential instead of waiting up to 60 s of backoff.
	d.mods.Stop(mod.ID())
	if err := d.mods.Start(mod.ID()); err != nil {
		return err
	}
	log.Printf("ntfy: Zugang erneuert und Modul neu gestartet")
	return nil
}

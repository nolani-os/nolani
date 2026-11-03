// Package modules: registry of clarad's background modules (ntfy push, folder
// sync, later computer use).
//
// Why in the daemon and not in the GUI (three-gate model):
// A module that later remote-controls the desktop must NOT have its control
// channel inside the controlled session. That is why all modules live here —
// the GUI only starts/stops them and renders consent dialogs.
package modules

import (
	"context"
	"sort"
	"sync"
	"time"
)

// State of a module (contract: protocol/control-api.md).
const (
	StateStopped     = "stopped"
	StateRunning     = "running"
	StateError       = "error"
	StateUnavailable = "unavailable" // exists, but is not usable (yet)
)

// Module is a background service with a lifecycle. Start does not block;
// a module runs until Stop is called or ctx ends.
type Module interface {
	ID() string
	Start(ctx context.Context) error
	Stop()
}

// Info is a module's outside view for the control API.
type Info struct {
	ID    string `json:"id"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
	// AllowedPeers is meant for future remote-control modules: which tailnet peers
	// may address this module at all (gate 3). Empty = nobody. Unused today,
	// deliberately already part of the contract.
	AllowedPeers []string `json:"allowed_peers,omitempty"`
}

type entry struct {
	mod    Module
	state  string
	errMsg string
	cancel context.CancelFunc
	peers  []string
}

type Registry struct {
	mu       sync.Mutex
	e        map[string]*entry
	consents map[string]*pendingConsent
	// onChange reports state changes to the outside (daemon → SSE).
	onChange func(Info)
}

func NewRegistry(onChange func(Info)) *Registry {
	return &Registry{e: map[string]*entry{}, onChange: onChange}
}

// Register adds a module (state: stopped).
//
// Idempotent: an already RUNNING module is not replaced. Otherwise a second
// startModules() pass (e.g. after saving the sync folders) creates a second
// instance while the first keeps running — for the ntfy module that meant
// every notification twice (observed in testing).
func (r *Registry) Register(m Module) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.e[m.ID()]; ok && old.state == StateRunning {
		return
	}
	r.e[m.ID()] = &entry{mod: m, state: StateStopped}
}

// RegisterPlaceholder registers a module that WILL exist but is not usable yet
// (e.g. `remote-desktop`). Makes visible in the UI what is coming, without any
// code existing for it.
func (r *Registry) RegisterPlaceholder(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.e[id] = &entry{state: StateUnavailable}
}

func (r *Registry) List() []Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Info, 0, len(r.e))
	for id, en := range r.e {
		out = append(out, Info{ID: id, State: en.state, Error: en.errMsg, AllowedPeers: en.peers})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (r *Registry) Start(id string) error {
	r.mu.Lock()
	en, ok := r.e[id]
	if !ok {
		r.mu.Unlock()
		return errUnknown
	}
	if en.mod == nil {
		r.mu.Unlock()
		return errUnavailable
	}
	if en.state == StateRunning {
		r.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	en.cancel = cancel
	en.state = StateRunning
	en.errMsg = ""
	mod := en.mod
	r.mu.Unlock()
	r.notify(id)

	go func() {
		if err := mod.Start(ctx); err != nil && ctx.Err() == nil {
			r.mu.Lock()
			if e2, ok := r.e[id]; ok {
				e2.state = StateError
				e2.errMsg = err.Error()
			}
			r.mu.Unlock()
			r.notify(id)
		}
	}()
	return nil
}

func (r *Registry) Stop(id string) {
	r.mu.Lock()
	en, ok := r.e[id]
	if !ok || en.state != StateRunning {
		r.mu.Unlock()
		return
	}
	if en.cancel != nil {
		en.cancel()
	}
	en.state = StateStopped
	mod := en.mod
	r.mu.Unlock()
	if mod != nil {
		mod.Stop()
	}
	r.notify(id)
}

// StopAll shuts everything down (tunnel down, app exiting).
func (r *Registry) StopAll() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.e))
	for id, en := range r.e {
		if en.state == StateRunning {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Stop(id)
	}
}

func (r *Registry) notify(id string) {
	if r.onChange == nil {
		return
	}
	r.mu.Lock()
	en, ok := r.e[id]
	var info Info
	if ok {
		info = Info{ID: id, State: en.state, Error: en.errMsg, AllowedPeers: en.peers}
	}
	r.mu.Unlock()
	if ok {
		r.onChange(info)
	}
}

// ── Consent (gate 2 of the three-gate model) ────────────────────────────────
//
// A module that is to remote-control the machine must NOT simply start because
// a peer asks for it. The flow is: request -> the user sees a dialog IN THE
// TAURI WINDOW (never in the shell WebView, which could be remote-controlled)
// -> approval applies to EXACTLY THIS connection and is NEVER stored.
//
// No module uses this yet; the contract exists so it doesn't get improvised
// under time pressure later.

// ConsentRequest is sent to the UI as an SSE event.
type ConsentRequest struct {
	ModuleID     string   `json:"module_id"`
	Peer         string   `json:"peer"`
	Capabilities []string `json:"capabilities"`
	Nonce        string   `json:"nonce"`
	TTLSeconds   int      `json:"ttl"`
}

type pendingConsent struct {
	req     ConsentRequest
	expires time.Time
	result  chan bool
}

// RequestConsent asks the user and blocks until answer or expiry.
// Returns false = rejected or expired (default is NO).
func (r *Registry) RequestConsent(req ConsentRequest, ask func(ConsentRequest)) bool {
	if req.TTLSeconds <= 0 {
		req.TTLSeconds = 60
	}
	pc := &pendingConsent{
		req:     req,
		expires: time.Now().Add(time.Duration(req.TTLSeconds) * time.Second),
		result:  make(chan bool, 1),
	}
	r.mu.Lock()
	if r.consents == nil {
		r.consents = map[string]*pendingConsent{}
	}
	r.consents[req.Nonce] = pc
	r.mu.Unlock()

	ask(req)

	select {
	case ok := <-pc.result:
		return ok
	case <-time.After(time.Until(pc.expires)):
		r.mu.Lock()
		delete(r.consents, req.Nonce)
		r.mu.Unlock()
		return false
	}
}

// ResolveConsent answers an open request (from the control API).
// Unknown or expired nonce -> false, so that a late click cannot approve
// something after the fact.
func (r *Registry) ResolveConsent(nonce string, granted bool) bool {
	r.mu.Lock()
	pc, ok := r.consents[nonce]
	if ok {
		delete(r.consents, nonce)
	}
	r.mu.Unlock()
	if !ok || time.Now().After(pc.expires) {
		return false
	}
	pc.result <- granted
	return true
}

type regError string

func (e regError) Error() string { return string(e) }

const (
	errUnknown     = regError("unbekanntes Modul")
	errUnavailable = regError("Modul ist (noch) nicht verfügbar")
)

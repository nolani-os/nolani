// Package control: clarad's local HTTP control API (contract:
// packages/desktop/protocol/control-api.md). Binds ONLY 127.0.0.1, auth via
// bearer token from the handshake file (0600), which the Tauri app polls.
package control

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"

	"claraos.de/companion/clarad/internal/core"
	"claraos.de/companion/clarad/internal/modules/devicecontrol"
	"claraos.de/companion/clarad/internal/provision"
	"claraos.de/companion/clarad/internal/state"
)

type handshake struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// Start binds 127.0.0.1:0, writes the handshake file atomically and serves.
// Does not block; returns the bound port.
func Start(d *core.Daemon, handshakeFile string) (int, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return 0, err
	}
	token := hex.EncodeToString(raw)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port

	hs, _ := json.Marshal(handshake{Port: port, Token: token, PID: os.Getpid()})
	if err := state.WriteFileAtomic(handshakeFile, hs, 0o600); err != nil {
		ln.Close()
		return 0, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.Status())
	})
	mux.HandleFunc("POST /v1/provision", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token   string `json:"token"`
			Backend string `json:"backend"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Token == "" {
			writeErr(w, http.StatusBadRequest, "token fehlt")
			return
		}
		if err := d.Provision(r.Context(), body.Token, body.Backend); err != nil {
			status := http.StatusBadGateway
			if he, ok := err.(*provision.HTTPError); ok {
				// 404 = invite invalid/expired, 410 = claim limit — pass through for the
				// UI message.
				status = he.Status
			}
			writeErr(w, status, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d.Status())
	})
	// The app passes in its WebView's session cookies; the daemon does the
	// fetching and installing itself because the tunnel lives here. The cookies
	// are deliberately in the body, not the path — paths end up in access logs.
	// Connect by server address (no invitation): direct, or through a tunnel the
	// user configures. The auth key travels in the body only and is never stored.
	mux.HandleFunc("POST /v1/connect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Server     string `json:"server"`
			ControlURL string `json:"control_url"`
			AuthKey    string `json:"auth_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Server == "" {
			writeErr(w, http.StatusBadRequest, "server fehlt")
			return
		}
		if err := d.Connect(body.Server, body.ControlURL, body.AuthKey); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d.Status())
	})
	mux.HandleFunc("POST /v1/push/refresh", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Cookies string `json:"cookies"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Cookies == "" {
			writeErr(w, http.StatusBadRequest, "cookies fehlen")
			return
		}
		if err := d.RefreshPushCredential(r.Context(), body.Cookies); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /v1/up", func(w http.ResponseWriter, r *http.Request) {
		if err := d.Up(); err != nil {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d.Status())
	})
	mux.HandleFunc("POST /v1/down", func(w http.ResponseWriter, r *http.Request) {
		_ = d.Down()
		writeJSON(w, http.StatusOK, d.Status())
	})
	mux.HandleFunc("GET /v1/events", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			writeErr(w, http.StatusInternalServerError, "kein Flusher")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		ch := d.Subscribe()
		defer d.Unsubscribe(ch)
		// Send the initial state immediately so the UI does not have to wait for the
		// first change.
		st, _ := json.Marshal(d.Status())
		fmt.Fprintf(w, "event: state.changed\ndata: %s\n\n", st)
		fl.Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case ev, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, ev.Data)
				fl.Flush()
			}
		}
	})
	mux.HandleFunc("GET /v1/modules", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.Modules().List())
	})
	mux.HandleFunc("POST /v1/modules/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		if err := d.Modules().Start(r.PathValue("id")); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d.Modules().List())
	})
	mux.HandleFunc("POST /v1/modules/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		d.Modules().Stop(r.PathValue("id"))
		writeJSON(w, http.StatusOK, d.Modules().List())
	})
	mux.HandleFunc("GET /v1/sync/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.SyncConfig())
	})
	mux.HandleFunc("PUT /v1/sync/config", func(w http.ResponseWriter, r *http.Request) {
		var sc state.SyncConfig
		if err := json.NewDecoder(r.Body).Decode(&sc); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltige Konfiguration")
			return
		}
		// Check the folders now instead of silently doing nothing later.
		for _, grp := range [][]string{sc.Immich.Folders, sc.Paperless.Folders} {
			for _, f := range grp {
				if st, err := os.Stat(f); err != nil || !st.IsDir() {
					writeErr(w, http.StatusBadRequest, "kein Ordner: "+f)
					return
				}
			}
		}
		if err := d.SetSyncConfig(sc); err != nil {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d.SyncConfig())
	})
	mux.HandleFunc("POST /v1/modules/{id}/consent", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Nonce   string `json:"nonce"`
			Granted bool   `json:"granted"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Nonce == "" {
			writeErr(w, http.StatusBadRequest, "nonce fehlt")
			return
		}
		if !d.Modules().ResolveConsent(body.Nonce, body.Granted) {
			// Unknown or expired — deliberately 409 rather than 200, so the UI does not
			// wrongly report "granted".
			writeErr(w, http.StatusConflict, "Anfrage unbekannt oder abgelaufen")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /v1/shutdown", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		go d.Shutdown()
	})

	// ── Device control (contract control-api.md) ───────────────────────────
	// Error mapping: 501 = capability missing on this device, 400 = input,
	// 502 = backend call failed (treat as transient).
	devErr := func(w http.ResponseWriter, err error) {
		switch {
		case devicecontrol.IsUnsupported(err):
			writeErr(w, http.StatusNotImplemented, err.Error())
		case devicecontrol.IsBadInput(err):
			writeErr(w, http.StatusBadRequest, err.Error())
		default:
			writeErr(w, http.StatusBadGateway, err.Error())
		}
	}
	mux.HandleFunc("GET /v1/device/state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.Device().State())
	})
	mux.HandleFunc("POST /v1/device/audio", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Volume *int  `json:"volume"`
			Muted  *bool `json:"muted"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltiger Body")
			return
		}
		st, err := d.Device().SetAudio(body.Volume, body.Muted)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("POST /v1/device/brightness", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Level *int `json:"level"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Level == nil {
			writeErr(w, http.StatusBadRequest, "level fehlt")
			return
		}
		st, err := d.Device().SetBrightness(*body.Level)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("POST /v1/device/mic", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Muted  *bool `json:"muted"`
			Volume *int  `json:"volume"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltiger Body")
			return
		}
		st, err := d.Device().SetMic(body.Muted, body.Volume)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("GET /v1/device/audio/devices", func(w http.ResponseWriter, r *http.Request) {
		devs, err := d.Device().AudioDevices()
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, devs)
	})
	mux.HandleFunc("POST /v1/device/audio/default", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Sink   string `json:"sink"`
			Source string `json:"source"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltiger Body")
			return
		}
		kind, id := "sink", body.Sink
		if body.Source != "" {
			kind, id = "source", body.Source
		}
		st, err := d.Device().SetDefaultAudioDevice(kind, id)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})

	// Wi-Fi/Bluetooth (Linux: NetworkManager/BlueZ). Where no provider probes
	// successfully — machines without radios — the module returns errUnsupported
	// and devErr turns that cleanly into 501 instead of a 404.
	mux.HandleFunc("POST /v1/device/wifi", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Enabled == nil {
			writeErr(w, http.StatusBadRequest, "enabled fehlt")
			return
		}
		st, err := d.Device().SetWifiEnabled(*body.Enabled)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("GET /v1/device/wifi/networks", func(w http.ResponseWriter, r *http.Request) {
		nets, err := d.Device().WifiNetworks()
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, nets)
	})
	mux.HandleFunc("POST /v1/device/wifi/connect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SSID string `json:"ssid"`
			PSK  string `json:"psk"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltiger Body")
			return
		}
		// 🔑 The password goes straight to NetworkManager. It is not logged and not
		// cached anywhere — not even in an error message (that would otherwise travel
		// across the bridge into the WebView).
		if err := d.Device().WifiConnect(body.SSID, body.PSK); err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /v1/device/bluetooth", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Enabled == nil {
			writeErr(w, http.StatusBadRequest, "enabled fehlt")
			return
		}
		st, err := d.Device().SetBluetoothEnabled(*body.Enabled)
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("GET /v1/device/bluetooth/devices", func(w http.ResponseWriter, r *http.Request) {
		devs, err := d.Device().BluetoothDevices()
		if err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, devs)
	})
	mux.HandleFunc("POST /v1/device/bluetooth/connect", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Address    string `json:"address"`
			Disconnect bool   `json:"disconnect"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "ungueltiger Body")
			return
		}
		if err := d.Device().BluetoothConnect(body.Address, body.Disconnect); err != nil {
			devErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	authed := func(next http.Handler) http.Handler {
		want := "Bearer " + token
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("Authorization")
			if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	go http.Serve(ln, authed(mux))
	return port, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

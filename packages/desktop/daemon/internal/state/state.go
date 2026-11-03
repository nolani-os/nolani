// Package state: OS paths, config persistence and secret storage for clarad.
//
// Secret trade-off: config.json holds the ntfy bearer, Immich API key and
// Paperless token. Linux = file 0600 (the tsnet node private key lives as a
// file in the state dir anyway — a keyring just for secondary tokens would be
// theatre plus KWallet pop-ups on family machines). Windows = file content
// encrypted with DPAPI (CryptProtectData, user scope), see secrets_windows.go.
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Paths are clarad's user-private directories.
type Paths struct {
	ConfigDir string // config.json
	DataDir   string // tsnet state, sync cursor, handshake file
	LogDir    string // rotating logs
}

// AppDirName names the state directories (Linux), so that two variants of the
// app on one computer never share pairing, tunnel key or logs. A variant build
// sets it at link time: -X <module>/internal/state.AppDirName=claraos-companion
var AppDirName = "nolani-companion"

// winDirName: the Windows folder (%APPDATA%, %LOCALAPPDATA%). Derived instead of a
// second link-time value because it contains a space; the home variant keeps the
// folder its released installs already use.
func winDirName() string {
	if AppDirName == "claraos-companion" {
		return "ClaraOS Companion"
	}
	return "Nolani Companion"
}

// DefaultPaths determines the default paths (Linux: XDG, Windows: AppData).
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	if runtime.GOOS == "windows" {
		appdata := os.Getenv("APPDATA")
		local := os.Getenv("LOCALAPPDATA")
		if appdata == "" || local == "" {
			return Paths{}, errors.New("APPDATA/LOCALAPPDATA nicht gesetzt")
		}
		return Paths{
			ConfigDir: filepath.Join(appdata, winDirName()),
			DataDir:   filepath.Join(local, winDirName()),
			LogDir:    filepath.Join(local, winDirName(), "logs"),
		}, nil
	}
	xdg := func(env, fallback string) string {
		if v := os.Getenv(env); v != "" {
			return filepath.Join(v, AppDirName)
		}
		return filepath.Join(home, fallback, AppDirName)
	}
	return Paths{
		ConfigDir: xdg("XDG_CONFIG_HOME", ".config"),
		DataDir:   xdg("XDG_DATA_HOME", ".local/share"),
		LogDir:    filepath.Join(xdg("XDG_STATE_HOME", ".local/state"), "logs"),
	}, nil
}

// Ensure creates all directories with 0700.
func (p Paths) Ensure() error {
	for _, d := range []string{p.ConfigDir, p.DataDir, p.LogDir, p.TsnetDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func (p Paths) ConfigFile() string { return filepath.Join(p.ConfigDir, "config.json") }
func (p Paths) TsnetDir() string   { return filepath.Join(p.DataDir, "tsnet") }

// Config = persisted provisioning response (everything EXCEPT auth_key — as on
// Android, that is never stored) plus local settings.
type Config struct {
	ShellURL     string `json:"shell_url"`
	ServerURL    string `json:"server_url"`
	ResolverAddr string `json:"resolver_addr,omitempty"`
	DisplayName  string `json:"display_name,omitempty"`
	Hostname     string `json:"hostname"`

	NtfyServer string `json:"ntfy_server,omitempty"`
	NtfyTopic  string `json:"ntfy_topic,omitempty"`
	NtfyAuth   string `json:"ntfy_auth,omitempty"`

	ImmichURL      string `json:"immich_url,omitempty"`
	ImmichAPIKey   string `json:"immich_api_key,omitempty"`
	PaperlessURL   string `json:"paperless_url,omitempty"`
	PaperlessToken string `json:"paperless_token,omitempty"`

	// Sync: folders chosen by the user. Empty = no sync (deliberate default —
	// nobody should see files uploaded without having asked for it).
	Sync SyncConfig `json:"sync"`
}

// SyncConfig holds the watched folders per target.
type SyncConfig struct {
	Immich    FolderSync `json:"immich"`
	Paperless FolderSync `json:"paperless"`
}

type FolderSync struct {
	Enabled bool     `json:"enabled"`
	Folders []string `json:"folders"`
}

// LoadConfig reads config.json; (nil, nil) if not provisioned yet.
func LoadConfig(p Paths) (*Config, error) {
	raw, err := os.ReadFile(p.ConfigFile())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := decryptSecrets(raw)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(plain, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// SaveConfig writes config.json atomically (tmp+rename) with 0600.
func SaveConfig(p Paths, c *Config) error {
	plain, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	enc, err := encryptSecrets(plain)
	if err != nil {
		return err
	}
	return WriteFileAtomic(p.ConfigFile(), enc, 0o600)
}

// WriteFileAtomic: tmp in the target directory + rename, so there is never a half-written file.
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NormalizeHostname turns the OS host name into the tailnet scheme
// `claraos-<hostname>`: lowercase, only [a-z0-9-], max. 63 characters.
func NormalizeHostname(osHostname string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(osHostname) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		case r == '.', r == '_', r == ' ':
			b.WriteRune('-')
		}
	}
	h := strings.Trim(b.String(), "-")
	if h == "" {
		h = "desktop"
	}
	// Prefix = the variant ("nolani-…", at home "claraos-…" as before).
	full := strings.TrimSuffix(AppDirName, "-companion") + "-" + h
	if len(full) > 63 {
		full = full[:63]
	}
	return strings.TrimRight(full, "-")
}

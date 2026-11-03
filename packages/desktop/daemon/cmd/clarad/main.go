// clarad — ClaraOS Companion Daemon (desktop).
//
// Runs as a Tauri sidecar: tsnet tunnel + SOCKS5 + provisioning + modules,
// controlled via the local control API (handshake file → port + token).
// Standalone start (development/tests) works the same way — then without
// --watch-stdin, so that EOF on stdin does not end the daemon immediately.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	"gopkg.in/natefinch/lumberjack.v2"

	"claraos.de/companion/clarad/internal/control"
	"claraos.de/companion/clarad/internal/core"
	"claraos.de/companion/clarad/internal/state"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

func main() {
	var (
		stateDir      = flag.String("state-dir", "", "Override für alle State-Pfade (Standard: OS-üblich, s. README)")
		handshakeFile = flag.String("handshake-file", "", "Pfad der Handshake-Datei (Standard: <data-dir>/handshake.json)")
		watchStdin    = flag.Bool("watch-stdin", false, "bei stdin-EOF beenden (Tauri-Sidecar: Eltern-Pipe = Lebenszeichen)")
		showVersion   = flag.Bool("version", false, "Version ausgeben und beenden")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	paths, err := state.DefaultPaths()
	if err != nil {
		log.Fatalf("state: %v", err)
	}
	if *stateDir != "" {
		paths = state.Paths{
			ConfigDir: *stateDir,
			DataDir:   *stateDir,
			LogDir:    filepath.Join(*stateDir, "logs"),
		}
	}
	if err := paths.Ensure(); err != nil {
		log.Fatalf("state: %v", err)
	}

	// Rotating logs (3×5 MB) — remote support = "send me the log file".
	log.SetOutput(io.MultiWriter(os.Stderr, &lumberjack.Logger{
		Filename:   filepath.Join(paths.LogDir, "clarad.log"),
		MaxSize:    5, // MB
		MaxBackups: 3,
	}))
	log.SetPrefix("[clarad] ")
	log.Printf("start version=%s config=%s data=%s", version, paths.ConfigDir, paths.DataDir)

	d, err := core.NewDaemon(paths, version)
	if err != nil {
		log.Fatalf("daemon: %v", err)
	}

	hf := *handshakeFile
	if hf == "" {
		hf = filepath.Join(paths.DataDir, "handshake.json")
	}
	port, err := control.Start(d, hf)
	if err != nil {
		log.Fatalf("control: %v", err)
	}
	log.Printf("control-api auf 127.0.0.1:%d, handshake=%s", port, hf)

	// Provisioned → bring the tunnel up right away (normal app start).
	if d.Status().State != core.StateUnprovisioned {
		if err := d.Up(); err != nil {
			log.Printf("up: %v", err)
		}
	}

	// Tauri sidecar orphan protection: parent pipe closed → EOF → clean exit
	// (robust on both OSes, no PID guessing).
	if *watchStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			log.Printf("stdin EOF — Elternprozess weg, beende")
			d.Shutdown()
		}()
	}

	<-d.Quit()
	_ = os.Remove(hf)
	log.Printf("bye")
}

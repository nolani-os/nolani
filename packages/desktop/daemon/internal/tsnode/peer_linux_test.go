package tsnode

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestSocketOwner(t *testing.T) {
	table := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A0B2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 20 4 30 10 -1
   1: 0100007F:1F90 0100007F:A0B2 01 00000000:00000000 00:00000000 00000000     0        0 2 1 0 20 4 30 10 -1
`
	uid, ok := socketOwner(strings.NewReader(table), 0xA0B2, 0x1F90)
	if !ok || uid != 1000 {
		t.Fatalf("client socket: uid %d ok %v", uid, ok)
	}
	if _, ok := socketOwner(strings.NewReader(table), 0xA0B3, 0x1F90); ok {
		t.Fatal("unknown port found")
	}
}

// A connection from this very process (same user) must get through.
func TestOwnerOnlyListenerAcceptsOwnUser(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	l := ownerOnlyListener{ln}
	got := make(chan error, 1)
	go func() {
		c, err := l.Accept()
		if err == nil {
			c.Close()
		}
		got <- err
	}()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("own connection was not accepted")
	}
}

// A connection from another account must be refused. Needs root (to connect as
// "nobody"); skipped otherwise.
func TestOwnerOnlyListenerRefusesOtherUser(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root")
	}
	if _, err := exec.LookPath("su"); err != nil {
		t.Skip("no su")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	l := ownerOnlyListener{ln}
	accepted := make(chan struct{}, 1)
	go func() {
		if c, err := l.Accept(); err == nil {
			c.Close()
			accepted <- struct{}{}
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	cmd := exec.Command("su", "-s", "/bin/bash", "nobody", "-c",
		fmt.Sprintf("exec 3<>/dev/tcp/127.0.0.1/%d; sleep 1", port))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("connect as nobody: %v %s", err, out)
	}
	select {
	case <-accepted:
		t.Fatal("connection of another user was accepted")
	case <-time.After(500 * time.Millisecond):
	}
	// The listener is still alive: our own connection right after gets through
	// (so the refusal above was the check, not a dead socket).
	own, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer own.Close()
	select {
	case <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("own connection after the refusal was not accepted")
	}
}

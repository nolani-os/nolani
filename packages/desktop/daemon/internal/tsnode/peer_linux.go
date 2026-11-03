package tsnode

import (
	"bufio"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
)

// sameUser looks up the client end of c in /proc/net/tcp (its local port is our
// remote port and vice versa) and compares the owning uid with ours.
func sameUser(c net.Conn) bool {
	local, ok1 := c.LocalAddr().(*net.TCPAddr)
	remote, ok2 := c.RemoteAddr().(*net.TCPAddr)
	if !ok1 || !ok2 {
		return false
	}
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(table)
		if err != nil {
			continue
		}
		uid, found := socketOwner(f, remote.Port, local.Port)
		f.Close()
		if found {
			return uid == os.Getuid()
		}
	}
	return false
}

// socketOwner finds the socket with local port lport and remote port rport in a
// /proc/net/tcp-format table and returns its uid.
func socketOwner(r io.Reader, lport, rport int) (int, bool) {
	sc := bufio.NewScanner(r)
	sc.Scan() // header
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 8 {
			continue
		}
		if hexPort(f[1]) != lport || hexPort(f[2]) != rport {
			continue
		}
		uid, err := strconv.Atoi(f[7])
		if err != nil {
			return 0, false
		}
		return uid, true
	}
	return 0, false
}

// hexPort extracts the port from "0100007F:1F90".
func hexPort(addr string) int {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return -1
	}
	p, err := strconv.ParseUint(addr[i+1:], 16, 16)
	if err != nil {
		return -1
	}
	return int(p)
}

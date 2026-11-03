package tsnode

import (
	"log"
	"net"
)

// ownerOnlyListener accepts only connections opened by processes of the user
// this daemon runs as. The SOCKS proxy on 127.0.0.1 is reachable by every local
// account, and it carries this device's tailnet identity — another user on a
// shared machine must not be able to use it. (The WebViews cannot authenticate
// to a SOCKS proxy, WebView2 not even to an HTTP one, so the check goes by the
// connecting process instead of a password.)
type ownerOnlyListener struct {
	net.Listener
}

func (l ownerOnlyListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if sameUser(c) {
			return c, nil
		}
		log.Printf("tsnode: proxy connection from another user refused (%s)", c.RemoteAddr())
		c.Close()
	}
}

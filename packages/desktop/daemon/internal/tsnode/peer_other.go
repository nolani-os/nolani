//go:build !linux && !windows

package tsnode

import "net"

// sameUser: no owner lookup on this platform — refuse rather than open the
// tunnel to every local account.
func sameUser(net.Conn) bool { return false }

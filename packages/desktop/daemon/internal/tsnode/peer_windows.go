package tsnode

import (
	"net"
	"net/netip"

	"golang.org/x/sys/windows"
	"tailscale.com/net/netstat"
)

// sameUser finds the client end of c in the TCP table (its local address is our
// remote address and vice versa) and compares the owning process's user with ours.
func sameUser(c net.Conn) bool {
	local, err1 := netip.ParseAddrPort(c.LocalAddr().String())
	remote, err2 := netip.ParseAddrPort(c.RemoteAddr().String())
	if err1 != nil || err2 != nil {
		return false
	}
	t, err := netstat.Get()
	if err != nil {
		return false
	}
	for _, e := range t.Entries {
		if sameAddrPort(e.Local, remote) && sameAddrPort(e.Remote, local) {
			return pidIsOurUser(uint32(e.Pid))
		}
	}
	return false
}

func sameAddrPort(a, b netip.AddrPort) bool {
	return a.Port() == b.Port() && a.Addr().Unmap() == b.Addr().Unmap()
}

func pidIsOurUser(pid uint32) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false // another user's process is not even queryable
	}
	defer windows.CloseHandle(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return false
	}
	defer tok.Close()
	theirs, err := tok.GetTokenUser()
	if err != nil {
		return false
	}
	ours, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	return windows.EqualSid(theirs.User.Sid, ours.User.Sid)
}

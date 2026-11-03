// Package tsnode embeds a tsnet instance (Tailscale in userspace) and provides
// a local SOCKS5 proxy through which the WebView traffic of the ClaraOS
// companion desktop app runs via the app's own tailnet tunnel.
//
// Port of packages/android/tsnet/claratsnet.go (proven approach).
// Differences from the Android original:
//   - No InterfaceProvider/netmon hack — that was only needed for the Android
//     netlink sandbox; desktop Linux/Windows can do net.Interfaces() natively.
//   - The tailnet resolver is a parameter from provisioning (resolver_addr)
//     instead of a constant; fallback = FallbackResolverAddr.
//
// Userspace netstack without TUN and without admin rights: therefore coexists
// with system VPNs (e.g. a commercial VPN) — tsnet traffic is ordinary
// outbound traffic, with DERP on 443 as fallback.
package tsnode

import (
	"context"
	"crypto/rand"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/net/socks5"
	"tailscale.com/tsnet"
)

// FallbackResolverAddr is a DNS server inside the tailnet, asked when the
// provisioning response carries no resolver_addr (older servers). We ask it
// EXPLICITLY because tsnet's default dial resolver does not reliably resolve
// public names that point to private addresses. Empty in the generic build;
// a variant build sets it at link time:
//
//	go build -ldflags "-X <module>/internal/tsnode.FallbackResolverAddr=10.0.0.53:53"
var FallbackResolverAddr = ""

// MagicDNSAddr is the resolver tsnet ITSELF provides inside the tunnel. It
// answers from the netmap — including the `extra_records` from the coordination
// server (e.g. Headscale), i.e. all of the server's host names — without a
// single packet leaving the machine.
//
// 🔑 Why this must be the PRIMARY path (measured on a laptop):
// Commercial VPNs enforce their own DNS and block port 53 to everything else.
// That hits us too, even though we ask "through the tunnel" — tsnet's path to
// a FOREIGN resolver ends up as an ordinary port-53 packet on the host.
// Measured with an active commercial VPN, same tunnel, same second:
//
//	100.100.100.100:53  → answer in 0.01 s
//	LAN DNS server:53   → silently dropped, aborted after 5.00 s
//	tailnet DNS:53      → silently dropped, aborted after 5.00 s
//	shell host:443      → connected in 0.01 s   (the data path was never broken)
//
// Without the VPN all four are reachable. So the failure was never the data
// path, only name resolution → "internal proxy error" in the window.
const MagicDNSAddr = "100.100.100.100:53"

// lookupTimeout applies PER resolver attempt. Previously the budget was 10 s
// for a single server — behind a VPN that meant 10 s waiting for a packet
// nobody ever answers. The normal case (MagicDNS) answers in milliseconds.
const lookupTimeout = 4 * time.Second

// Node wraps an embedded tsnet instance plus a local SOCKS5 proxy.
type Node struct {
	srv          *tsnet.Server
	resolverAddr string
	mu           sync.Mutex
	proxyPort    int
}

// New creates a Node. stateDir = persistent, user-private directory
// (state.Paths.TsnetDir). controlURL = the coordination server (from
// provisioning), hostname = normalised device name (claraos-<hostname>).
func New(stateDir, controlURL, hostname, resolverAddr string) *Node {
	// No log upload to Tailscale's log service: tsnet enables it by default, even
	// with a self-hosted control server (Headscale). Logs stay on this device.
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	// Otherwise tsnet's logpolicy looks for a writable directory for its log
	// state; pointing it at the state dir keeps tsnet logs out of home roots.
	_ = os.Setenv("TS_LOGS_DIR", stateDir)
	if resolverAddr == "" {
		resolverAddr = FallbackResolverAddr
	}
	return &Node{
		srv: &tsnet.Server{
			Dir:        stateDir,
			ControlURL: controlURL,
			Hostname:   hostname,
		},
		resolverAddr: resolverAddr,
	}
}

// Start brings the tunnel up. The first time, the short-TTL preauth key is
// used; afterwards the persisted state suffices (authKey may be empty).
// Blocks until connected or timeout (90 s, as on Android).
func (n *Node) Start(ctx context.Context, authKey string) error {
	if authKey != "" {
		n.srv.AuthKey = authKey
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	_, err := n.srv.Up(ctx)
	return err
}

// StartSocksProxy starts a local SOCKS5 proxy on 127.0.0.1 that dials through
// the tunnel (including resolving internal names via the tailnet resolver).
// Returns the bound port. Idempotent.
func (n *Node) StartSocksProxy() (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.proxyPort != 0 {
		return n.proxyPort, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	// UDP resolver as fallback (the Android path). 🔑 On desktop, DNS over UDP
	// through the tunnel hangs: TCP to the tailnet resolver dials cleanly, UDP via
	// netstack + subnet route runs into timeouts. That is why the primary path is
	// DNS-over-TCP (see lookupHostTCP).
	udpResolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return n.srv.Dial(ctx, "udp", n.resolverAddr)
		},
	}
	s := &socks5.Server{Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host) == nil {
			// Host name → resolve explicitly via the tailnet resolver, then dial the IP.
			if ip, e := n.lookupHostTCP(ctx, host); e == nil && ip != "" {
				addr = net.JoinHostPort(ip, port)
			} else if ips, e2 := udpResolver.LookupHost(ctx, host); e2 == nil && len(ips) > 0 {
				addr = net.JoinHostPort(ips[0], port)
			}
		}
		return n.srv.Dial(ctx, network, addr)
	}}
	// Only this user's processes may use the tunnel (see ownerOnlyListener).
	go s.Serve(ownerOnlyListener{ln})
	n.proxyPort = ln.Addr().(*net.TCPAddr).Port
	return n.proxyPort, nil
}

// resolvers returns the resolvers in the order they are asked: first tsnet's
// own (always reachable, knows the server's host names from the netmap), then
// the one from provisioning. The second stays in because only it can answer
// names that are NOT in the extra_records.
func (n *Node) resolvers() []string {
	list := []string{MagicDNSAddr}
	if n.resolverAddr != "" && n.resolverAddr != MagicDNSAddr {
		list = append(list, n.resolverAddr)
	}
	return list
}

// lookupHostTCP asks the resolvers in turn via DNS-over-TCP and returns the
// first A address found. A server that does not answer costs at most
// lookupTimeout — not the whole call.
func (n *Node) lookupHostTCP(ctx context.Context, host string) (string, error) {
	var lastErr error
	for _, server := range n.resolvers() {
		ip, err := n.lookupHostTCPVia(ctx, server, host)
		if err == nil && ip != "" {
			return ip, nil
		}
		lastErr = err
		// Abort only if the CALLER has given up — a single resolver timeout must not
		// swallow the next attempt.
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = errNoAnswer
	}
	return "", lastErr
}

// lookupHostTCPVia asks ONE resolver via DNS-over-TCP (RFC 1035 §4.2.2:
// 2-byte length prefix) through the tunnel.
//
// Why not net.Resolver: with PreferGo it sends UDP first and on a dial error
// falls back to the next server instead of to TCP — but through the tunnel,
// UDP is exactly the path that hangs.
func (n *Node) lookupHostTCPVia(ctx context.Context, server, host string) (string, error) {
	fqdn := host
	if !strings.HasSuffix(fqdn, ".") {
		fqdn += "."
	}
	name, err := dnsmessage.NewName(fqdn)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, lookupTimeout)
	defer cancel()

	conn, err := n.srv.Dial(ctx, "tcp", server)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}

	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: dnsQueryID(), RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
	}
	packed, err := msg.Pack()
	if err != nil {
		return "", err
	}
	if _, err := conn.Write(append([]byte{byte(len(packed) >> 8), byte(len(packed))}, packed...)); err != nil {
		return "", err
	}

	var lenBuf [2]byte
	if _, err := io.ReadFull(conn, lenBuf[:]); err != nil {
		return "", err
	}
	respBuf := make([]byte, int(lenBuf[0])<<8|int(lenBuf[1]))
	if _, err := io.ReadFull(conn, respBuf); err != nil {
		return "", err
	}

	var p dnsmessage.Parser
	if _, err := p.Start(respBuf); err != nil {
		return "", err
	}
	if err := p.SkipAllQuestions(); err != nil {
		return "", err
	}
	for {
		h, err := p.AnswerHeader()
		if err == dnsmessage.ErrSectionDone {
			return "", errNoAnswer
		}
		if err != nil {
			return "", err
		}
		if h.Type == dnsmessage.TypeA {
			r, err := p.AResource()
			if err != nil {
				return "", err
			}
			return net.IP(r.A[:]).String(), nil
		}
		if err := p.SkipAnswer(); err != nil {
			return "", err
		}
	}
}

type tsnodeError string

func (e tsnodeError) Error() string { return string(e) }

const errNoAnswer = tsnodeError("kein A-Record in der DNS-Antwort")

// dnsQueryID: DNS transaction ID. Over TCP with its own connection per query
// it is not critical, but it is varied anyway.
func dnsQueryID() uint16 {
	var b [2]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0x1234
	}
	return uint16(b[0])<<8 | uint16(b[1])
}

// Dial opens a connection through the tunnel (for modules: ntfy WS, uploads).
func (n *Node) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return n.srv.Dial(ctx, network, addr)
}

// Close shuts down tsnet and the proxy.
func (n *Node) Close() error {
	return n.srv.Close()
}

// Package claratsnet embeds a tsnet instance (Tailscale in userspace) and
// provides a local, password-protected HTTP proxy through which the WebView traffic of the
// ClaraOS companion app runs through the app's own tailnet tunnel.
//
// Why tsnet+proxy instead of a system VpnService:
//   - No VpnService → no consent dialog, no VPN slot conflict, no
//     "only one VPN" limit, no collision with the device's always-on VPN.
//   - Only the WebView (+ upload/push via Node.Dial) enters the tailnet,
//     not the whole device — exactly what the companion app needs.
//
// gomobile bind target: android .aar. The API is deliberately gomobile-friendly
// (only string/int/error and the bound type *Node).
package claratsnet

import (
	"context"
	"net"
	"os"
	"sync"
	"time"

	"github.com/tailscale/tailscale-android/libtailscale/ifaceparse"
	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

// InterfaceProvider returns the device's network interfaces as JSON
// (format as in tailscale-android App.kt: [{"name","index","mtu","up","broadcast",
// "loopback","pointToPoint","multicast","addrs":[{"ip","prefixLen"}]}]).
// Implemented on the Java side (Android NetworkInterface — bypasses netlink,
// which Android sandboxes from 11 on). gomobile binds it as a Java interface.
type InterfaceProvider interface {
	GetInterfacesAsJson() (string, error)
}

// resolverAddr is the DNS server asked through the tunnel for every host name.
// We ask one EXPLICITLY because tsnet's default dial resolver does not reliably
// resolve public names that point to private addresses. Default: tsnet's own
// MagicDNS. The app sets its build variant's resolver via SetResolverAddr
// before starting a node.
var (
	resolverMu   sync.Mutex
	resolverAddr = "100.100.100.100:53"
)

// SetResolverAddr replaces the resolver for nodes started afterwards. An empty
// value keeps the current one.
func SetResolverAddr(addr string) {
	if addr == "" {
		return
	}
	resolverMu.Lock()
	resolverAddr = addr
	resolverMu.Unlock()
}

func currentResolverAddr() string {
	resolverMu.Lock()
	defer resolverMu.Unlock()
	return resolverAddr
}

// Node wraps an embedded tsnet instance plus a local SOCKS5 proxy.
type Node struct {
	srv       *tsnet.Server
	mu        sync.Mutex
	proxyPort int
	proxy     *authProxy
}

// NewNode creates a Node. stateDir must be an app-private, persistent
// directory (e.g. context.getFilesDir()/tsnet). controlURL = the coordination
// server, e.g. Headscale (from provisioning), hostname = device display name.
//
// ifaces MUST be set: on Android the sandbox blocks `net.Interfaces()`
// (netlink) → tsnet.Up fails with `netlinkrib: permission denied`. The
// interface getter reads them from Java instead (Android NetworkInterface).
func NewNode(stateDir, controlURL, hostname string, ifaces InterfaceProvider) *Node {
	// No log upload to Tailscale's log service: tsnet enables it by default, even
	// with a self-hosted control server (Headscale). Logs stay on this device.
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	// Otherwise tsnet's logpolicy looks for a writable directory for the log
	// state and panics on Android ("no safe place found to store log state").
	// TS_LOGS_DIR takes precedence → point it at the app-private stateDir.
	_ = os.Setenv("TS_LOGS_DIR", stateDir)
	if ifaces != nil {
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
			js, err := ifaces.GetInterfacesAsJson()
			if err != nil {
				return nil, err
			}
			got, _, err := ifaceparse.ParseInterfacesJSONAsNetmon([]byte(js))
			return got, err
		})
	}
	return &Node{srv: &tsnet.Server{
		Dir:        stateDir,
		ControlURL: controlURL,
		Hostname:   hostname,
	}}
}

// StartWithAuthKey brings the tunnel up. The first time, the short-TTL
// pre-auth key is used; afterwards the persisted state suffices (authKey may be
// empty). Blocks until connected or timed out.
func (n *Node) StartWithAuthKey(authKey string) error {
	if authKey != "" {
		n.srv.AuthKey = authKey
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	_, err := n.srv.Up(ctx)
	return err
}

// StartProxy starts the local HTTP proxy on 127.0.0.1 that dials through the
// tunnel (incl. resolution of internal names via the tailnet resolver). Every
// request needs ProxyUser/ProxyPassword (see authProxy). Returns the bound port.
// Idempotent — repeated calls return the same port.
func (n *Node) StartProxy() (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.proxyPort != 0 {
		return n.proxyPort, nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	// Resolver that sends DNS queries through the tunnel to the tailnet resolver.
	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return n.srv.Dial(ctx, "udp", currentResolverAddr())
		},
	}
	n.proxy = newAuthProxy(func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host) == nil {
			// Host name → resolve explicitly via the tailnet resolver, then dial the IP.
			if ips, e := resolver.LookupHost(ctx, host); e == nil && len(ips) > 0 {
				addr = net.JoinHostPort(ips[0], port)
			}
		}
		return n.srv.Dial(ctx, network, addr)
	})
	n.proxy.serve(ln)
	n.proxyPort = ln.Addr().(*net.TCPAddr).Port
	return n.proxyPort, nil
}

// ProxyUser is the user name the proxy expects (empty before StartProxy).
func (n *Node) ProxyUser() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.proxy == nil {
		return ""
	}
	return n.proxy.user
}

// ProxyPassword is this run's random proxy password (empty before StartProxy).
func (n *Node) ProxyPassword() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.proxy == nil {
		return ""
	}
	return n.proxy.pass
}

// Close shuts down tsnet and the proxy.
func (n *Node) Close() error {
	return n.srv.Close()
}

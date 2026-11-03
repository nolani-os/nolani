package claratsnet

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

// authProxy is the local HTTP proxy (CONNECT for https, absolute-form for http)
// that carries the app's traffic into the tunnel. Every request must present the
// per-start random credentials: on Android all apps share 127.0.0.1, and without a
// password any of them could find the port and use this phone's tailnet identity.
// (A SOCKS5 proxy cannot be used here: the WebView's proxy override has no way
// to authenticate to one, but it answers an HTTP proxy's 407 challenge.)
type authProxy struct {
	dial func(ctx context.Context, network, addr string) (net.Conn, error)
	user string
	pass string
	fwd  *httputil.ReverseProxy
}

const proxyRealm = "companion"

func newAuthProxy(dial func(ctx context.Context, network, addr string) (net.Conn, error)) *authProxy {
	p := &authProxy{dial: dial, user: "companion", pass: randomHex(24)}
	p.fwd = &httputil.ReverseProxy{
		// Absolute-form request: the target is already in the URL. ReverseProxy
		// drops the hop-by-hop headers, Proxy-Authorization included.
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = pr.In.URL
			pr.Out.Host = pr.In.Host
		},
		Transport: &http.Transport{
			DialContext:         dial,
			Proxy:               nil,
			MaxIdleConns:        16,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 20 * time.Second,
		},
	}
	return p
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // no randomness → no safe proxy; never start without a password
	}
	return hex.EncodeToString(b)
}

func (p *authProxy) authorized(r *http.Request) bool {
	h := r.Header.Get("Proxy-Authorization")
	const prefix = "Basic "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(h[len(prefix):]))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(raw, []byte(p.user+":"+p.pass)) == 1
}

func (p *authProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !p.authorized(r) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="`+proxyRealm+`"`)
		http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "absolute http URL or CONNECT expected", http.StatusBadRequest)
		return
	}
	p.fwd.ServeHTTP(w, r)
}

func (p *authProxy) connect(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	up, err := p.dial(ctx, "tcp", r.Host)
	cancel()
	if err != nil {
		http.Error(w, "upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		up.Close()
		http.Error(w, "no hijacking", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		up.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		client.Close()
		up.Close()
		return
	}
	// Bytes the client sent right after the CONNECT header (e.g. a TLS hello).
	if n := buf.Reader.Buffered(); n > 0 {
		pending, _ := buf.Reader.Peek(n)
		if _, err := up.Write(pending); err != nil {
			client.Close()
			up.Close()
			return
		}
	}
	go func() {
		io.Copy(up, client)
		up.Close()
	}()
	io.Copy(client, up)
	client.Close()
}

// serve runs the proxy on ln until it is closed.
func (p *authProxy) serve(ln net.Listener) {
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second}
	go srv.Serve(ln)
}

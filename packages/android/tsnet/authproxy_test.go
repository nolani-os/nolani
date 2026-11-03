package claratsnet

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func startTestProxy(t *testing.T) (*authProxy, string) {
	t.Helper()
	var d net.Dialer
	p := newAuthProxy(d.DialContext)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	p.serve(ln)
	return p, ln.Addr().String()
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestProxyRequiresCredentials(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials leaked to the target")
		}
		fmt.Fprint(w, "hello")
	}))
	defer backend.Close()
	p, addr := startTestProxy(t)
	proxyURL, _ := url.Parse("http://" + addr)

	for name, auth := range map[string]string{
		"none":  "",
		"wrong": basic(p.user, "wrong"),
	} {
		req, _ := http.NewRequest("GET", backend.URL, nil)
		if auth != "" {
			req.Header.Set("Proxy-Authorization", auth)
		}
		c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusProxyAuthRequired {
			t.Errorf("%s: status %d, want 407", name, resp.StatusCode)
		}
		if !strings.Contains(resp.Header.Get("Proxy-Authenticate"), proxyRealm) {
			t.Errorf("%s: no challenge", name)
		}
	}

	proxyURL.User = url.UserPassword(p.user, p.pass)
	c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	resp, err := c.Get(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "hello" {
		t.Fatalf("forward: %d %q", resp.StatusCode, body)
	}
}

func TestProxyConnect(t *testing.T) {
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "tls ok")
	}))
	defer backend.Close()
	p, addr := startTestProxy(t)
	target := strings.TrimPrefix(backend.URL, "https://")

	// Without credentials the CONNECT is refused.
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	conn.Close()
	if err != nil || resp.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("unauthenticated CONNECT: %v %v", resp, err)
	}

	proxyURL, _ := url.Parse("http://" + addr)
	proxyURL.User = url.UserPassword(p.user, p.pass)
	tr := backend.Client().Transport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(proxyURL)
	r2, err := (&http.Client{Transport: tr}).Get(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if string(body) != "tls ok" {
		t.Fatalf("CONNECT body %q", body)
	}
}

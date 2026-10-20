package libre

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEgressUpstreamPinsDestinationAndPreservesHTTPHost(t *testing.T) {
	for _, transport := range []string{"http", "unix"} {
		t.Run(transport, func(t *testing.T) {
			var contacted atomic.Int32
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				contacted.Add(1)
				if r.Method != "CONNECT" || r.Host != "8.8.8.8:80" {
					t.Errorf("unvalidated upstream destination: %s %s", r.Method, r.Host)
					w.WriteHeader(403)
					return
				}
				c, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer c.Close()
				c.SetDeadline(time.Now().Add(3 * time.Second))
				rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
				rw.Flush()
				req, err := http.ReadRequest(rw.Reader)
				if err != nil {
					t.Error(err)
					return
				}
				req.Body.Close()
				if req.Host != "example.com" {
					t.Errorf("HTTP Host lost: %s", req.Host)
				}
				rw.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied")
				rw.Flush()
			})
			e := &Egress{Lookup: func(context.Context, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
			}}
			if transport == "http" {
				proxy := httptest.NewServer(handler)
				defer proxy.Close()
				if err := configureEgressUpstream(e, proxy.URL, ""); err != nil {
					t.Fatal(err)
				}
			} else {
				path := filepath.Join(t.TempDir(), "proxy.sock")
				listener, err := listenEgressSocket(path)
				if err != nil {
					t.Fatal(err)
				}
				server := &http.Server{Handler: handler}
				defer server.Close()
				go server.Serve(listener)
				if err := configureEgressUpstream(e, "", path); err != nil {
					t.Fatal(err)
				}
			}
			response := httptest.NewRecorder()
			e.ServeHTTP(response, httptest.NewRequest("GET", "http://example.com/", nil))
			if response.Code != 200 || response.Body.String() != "proxied" {
				t.Fatalf("upstream response: %d %q", response.Code, response.Body.String())
			}
			for _, destination := range []string{"127.0.0.1:443", "169.254.169.254:80", "8.8.8.8:22"} {
				if c, err := e.dial(context.Background(), "tcp", destination); err == nil {
					c.Close()
					t.Fatal("private destination allowed", destination)
				}
			}
			if contacted.Load() != 1 {
				t.Fatal("denied target reached upstream")
			}
		})
	}
}

func TestEgressUpstreamFailsClosed(t *testing.T) {
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "denied", 403) }))
	defer denied.Close()
	e := &Egress{}
	if err := configureEgressUpstream(e, denied.URL, ""); err != nil {
		t.Fatal(err)
	}
	if c, err := e.dial(context.Background(), "tcp", "8.8.8.8:443"); err == nil {
		c.Close()
		t.Fatal("upstream denial ignored")
	}
	if err := configureEgressUpstream(e, "", filepath.Join(t.TempDir(), "missing.sock")); err != nil {
		t.Fatal(err)
	}
	if c, err := e.dial(context.Background(), "tcp", "8.8.8.8:443"); err == nil {
		c.Close()
		t.Fatal("unavailable upstream bypassed")
	}
	for _, proxyURL := range []string{"https://localhost:20171", "http://user:pass@localhost:20171", "http://localhost", "http://localhost:20171/path"} {
		if configureEgressUpstream(e, proxyURL, "") == nil {
			t.Fatal("invalid upstream accepted", proxyURL)
		}
	}
	if configureEgressUpstream(e, denied.URL, "/socket") == nil {
		t.Fatal("ambiguous upstream accepted")
	}
}

func TestEgressUplinkConnectTunnel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "8.8.8.8:443" {
			t.Errorf("unexpected tunnel %q", r.Host)
		}
		c, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		rw.Flush()
		payload := make([]byte, 4)
		if _, err := io.ReadFull(rw, payload); err != nil {
			t.Error(err)
			return
		}
		c.Write(payload)
	}))
	defer upstream.Close()
	e := &Egress{}
	if err := configureEgressUpstream(e, upstream.URL, ""); err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(e)
	defer gateway.Close()
	c, err := net.DialTimeout("tcp", strings.TrimPrefix(gateway.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(c, "CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8:443\r\n\r\n")
	reader := bufio.NewReader(c)
	response, err := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("tunnel response: %v %v", response, err)
	}
	io.WriteString(c, "ping")
	payload := make([]byte, 4)
	if _, err := io.ReadFull(reader, payload); err != nil || string(payload) != "ping" {
		t.Fatalf("tunnel data: %q %v", payload, err)
	}
}

func TestEgressUplinkSocketOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proxy.sock")
	listener, err := listenEgressSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("socket permissions: %v %v", info, err)
	}
	if second, err := listenEgressSocket(path); err == nil {
		second.Close()
		t.Fatal("live socket replaced")
	}
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if second, err := listenEgressSocket(file); err == nil {
		second.Close()
		t.Fatal("regular file replaced")
	}
}

func TestUpstreamPreservesBufferedTunnelBytes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer c.Close()
		rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\nready")
		rw.Flush()
	}))
	defer upstream.Close()
	e := &Egress{}
	if err := configureEgressUpstream(e, upstream.URL, ""); err != nil {
		t.Fatal(err)
	}
	c, err := e.dial(context.Background(), "tcp", "8.8.8.8:443")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	data, err := io.ReadAll(c)
	if err != nil || string(data) != "ready" {
		t.Fatalf("lost buffered bytes: %q %v", data, err)
	}
}

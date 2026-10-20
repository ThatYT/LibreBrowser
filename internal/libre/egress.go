package libre

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

var blockedPrefixes = func() []netip.Prefix {
	var ps []netip.Prefix
	for _, s := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"} {
		ps = append(ps, netip.MustParsePrefix(s))
	}
	return ps
}()

func PublicIP(ip netip.Addr, extra []netip.Prefix) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return false
		}
	}
	for _, p := range extra {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

type Egress struct {
	Deny   []netip.Prefix
	Lookup func(context.Context, string) ([]netip.Addr, error)
	Dial   func(context.Context, string, string) (net.Conn, error)
}

func (e *Egress) dial(ctx context.Context, _, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || (port != "80" && port != "443") {
		return nil, ErrDenied
	}
	return e.resolveDial(ctx, host, port)
}
func (e *Egress) resolveDial(ctx context.Context, host, port string) (net.Conn, error) {
	var ips []netip.Addr
	var err error
	if ip, parseErr := netip.ParseAddr(host); parseErr == nil {
		ips = []netip.Addr{ip}
	} else if e.Lookup != nil {
		ips, err = e.Lookup(ctx, host)
	} else {
		ips, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	if err != nil || len(ips) == 0 {
		return nil, errors.New("destination unavailable")
	}
	for _, ip := range ips {
		if !PublicIP(ip, e.Deny) {
			return nil, ErrDenied
		}
	}
	dial := e.Dial
	if dial == nil {
		dial = (&net.Dialer{Timeout: 15 * time.Second}).DialContext
	}
	for _, ip := range ips {
		c, e := dial(ctx, "tcp", net.JoinHostPort(ip.String(), port))
		if e == nil {
			return c, nil
		}
		err = e
	}
	return nil, err
}
func (e *Egress) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == "CONNECT" {
		dst, err := e.dial(r.Context(), "tcp", r.Host)
		if err != nil {
			http.Error(w, "destination denied", 403)
			return
		}
		defer dst.Close()
		h, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "upgrade unavailable", 500)
			return
		}
		client, rw, err := h.Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		client.SetDeadline(time.Now().Add(1 * time.Hour))
		dst.SetDeadline(time.Now().Add(1 * time.Hour))
		rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		rw.Flush()
		done := make(chan struct{})
		go func() { io.Copy(dst, rw); dst.Close(); close(done) }()
		io.Copy(client, dst)
		client.Close()
		<-done
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" || r.URL.User != nil {
		http.Error(w, "HTTP proxy requests only", 400)
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	stripHop(out.Header)
	out.Header.Del("Proxy-Authorization")
	tr := &http.Transport{Proxy: nil, DialContext: e.dial, ResponseHeaderTimeout: 30 * time.Second, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	res, err := tr.RoundTrip(out)
	if err != nil {
		http.Error(w, "destination denied or unavailable", 403)
		return
	}
	defer res.Body.Close()
	stripHop(res.Header)
	for k, vs := range res.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	io.Copy(w, io.LimitReader(res.Body, 1<<30))
}
func stripHop(h http.Header) {
	for _, k := range strings.Split(h.Get("Connection"), ",") {
		h.Del(strings.TrimSpace(k))
	}
	for _, k := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"} {
		h.Del(k)
	}
}
func ServeEgress(ctx context.Context) error {
	e := &Egress{}
	if err := configureEgressUpstream(e, env("EGRESS_UPSTREAM_PROXY", ""), env("EGRESS_UPSTREAM_SOCKET", "")); err != nil {
		return err
	}
	for _, s := range strings.Split(env("EGRESS_DENY_CIDRS", ""), ",") {
		if s == "" {
			continue
		}
		p, err := netip.ParsePrefix(strings.TrimSpace(s))
		if err != nil {
			return err
		}
		e.Deny = append(e.Deny, p)
	}
	server := &http.Server{Addr: ":3128", Handler: e, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() { <-ctx.Done(); server.Close() }()
	if path := env("EGRESS_LISTEN_SOCKET", ""); path != "" {
		listener, err := listenEgressSocket(path)
		if err != nil {
			return err
		}
		defer listener.Close()
		return server.Serve(listener)
	}
	return server.ListenAndServe()
}

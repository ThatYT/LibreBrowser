package libre

import (
	"context"
	"net"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestEgressBlocksSpecialAddresses(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.1.1.1", "172.17.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "198.18.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1"} {
		if PublicIP(netip.MustParseAddr(s), nil) {
			t.Fatal("private destination allowed", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !PublicIP(netip.MustParseAddr(s), nil) {
			t.Fatal("public blocked", s)
		}
	}
	if PublicIP(netip.MustParseAddr("1.1.1.1"), []netip.Prefix{netip.MustParsePrefix("1.1.1.1/32")}) {
		t.Fatal("custom deny ignored")
	}
}
func TestEgressPinsDNSAndRejectsMixedAnswers(t *testing.T) {
	var dialed string
	e := &Egress{Lookup: func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}, Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialed = addr
		return nil, ErrDenied
	}}
	e.dial(context.Background(), "tcp", "example.com:443")
	if dialed != "8.8.8.8:443" {
		t.Fatal("DNS was not pinned", dialed)
	}
	dialed = ""
	e.Lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}
	e.dial(context.Background(), "tcp", "example.com:443")
	if dialed != "" {
		t.Fatal("mixed DNS answers dialed")
	}
	if _, err := e.dial(context.Background(), "tcp", "8.8.8.8:22"); err == nil {
		t.Fatal("management port allowed")
	}
}
func TestEgressRejectsOriginServerRequests(t *testing.T) {
	e := &Egress{}
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}

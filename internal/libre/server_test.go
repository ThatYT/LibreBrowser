package libre

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeBackend struct {
	mu            sync.Mutex
	starts, stops int
	transport     http.RoundTripper
}

func (b *fakeBackend) Command(ctx context.Context, id, action string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if action == "start" {
		b.starts++
	}
	if action == "stop" {
		b.stops++
	}
	return nil
}
func (b *fakeBackend) Proxy() http.RoundTripper { return b.transport }
func testApp(t *testing.T) (*App, User, User) {
	s := testStore(t)
	admin := mustUser(t, s, "thatyt", "ADMIN", true)
	user := mustUser(t, s, "reader", "USER", false)
	return NewApp(s, Config{Origin: "https://browser.test", Trusted: nil, Grace: 5 * time.Minute}, &fakeBackend{transport: http.DefaultTransport}), admin, user
}
func request(a *App, method, path, body, token, csrf string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://browser.test"+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", a.Config.Origin)
	r.Header.Set("X-CSRF-Token", csrf)
	if token != "" {
		r.AddCookie(&http.Cookie{Name: a.cookieName(), Value: token})
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func TestAuthRolesAndCSRF(t *testing.T) {
	a, admin, user := testApp(t)
	ut, uc, _ := a.Store.NewSession(user)
	at, ac, _ := a.Store.NewSession(admin)
	for _, p := range []string{"/api/me", "/api/admin/users", "/browser/", "/browser/websocket"} {
		if w := request(a, "GET", p, "", "", ""); w.Code != 401 {
			t.Fatal(p, w.Code)
		}
	}
	if w := request(a, "GET", "/api/admin/users", "", ut, ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request(a, "POST", "/api/admin/users", `{"username":"new","password":"long-new-password"}`, at, ""); w.Code != 403 {
		t.Fatal("csrf", w.Code)
	}
	if w := request(a, "POST", "/api/admin/users", `{"username":"new","password":"long-new-password"}`, at, ac); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(a, "POST", "/api/logout", `{}`, ut, uc); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", "/api/me", "", ut, ""); w.Code != 401 {
		t.Fatal("logout", w.Code)
	}
}
func TestLoginHeadersOriginAndRateLimit(t *testing.T) {
	a, _, _ := testApp(t)
	w := request(a, "POST", "/api/login", `{"username":"thatyt","password":"long-test-password"}`, "", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal(cookies)
	}
	for _, modify := range []func(*http.Request){func(r *http.Request) { r.Host = "evil.test" }, func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, func(r *http.Request) { r.TLS = nil; r.Header.Set("X-Forwarded-Proto", "https") }} {
		r := httptest.NewRequest("POST", "https://browser.test/api/login", strings.NewReader(`{}`))
		r.Header.Set("Origin", a.Config.Origin)
		modify(r)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code < 400 {
			t.Fatal("forged origin/header accepted")
		}
	}
	a.mu.Lock()
	a.attempts["ip:192.0.2.1"] = attempt{Count: 10, Until: time.Now().Add(time.Hour)}
	a.mu.Unlock()
	w = request(a, "POST", "/api/login", `{"username":"thatyt","password":"long-test-password"}`, "", "")
	if w.Code != 429 {
		t.Fatal("rate limit", w.Code)
	}
}
func TestOwnPasswordRequiresCurrentAndRevokes(t *testing.T) {
	a, _, u := testApp(t)
	token, csrf, _ := a.Store.NewSession(u)
	if w := request(a, "POST", "/api/account/password", `{"current_password":"wrong","password":"new-long-password"}`, token, csrf); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := request(a, "POST", "/api/account/password", `{"current_password":"long-test-password","password":"new-long-password"}`, token, csrf); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, e := a.Store.Session(token); e == nil {
		t.Fatal("password session not revoked")
	}
}
func TestLifecycleGraceAndMultipleConnections(t *testing.T) {
	a, _, u := testApp(t)
	b := a.Backend.(*fakeBackend)
	if e := a.Start(context.Background(), u.ID); e != nil {
		t.Fatal(e)
	}
	a.mu.Lock()
	entry := a.activity[u.ID]
	entry.Connections = 2
	entry.LastIdle = time.Now().Add(-time.Hour)
	a.mu.Unlock()
	a.Sweep(context.Background(), time.Now())
	if b.stops != 0 {
		t.Fatal("active stopped")
	}
	a.mu.Lock()
	entry.Connections = 0
	entry.LastIdle = time.Now()
	a.mu.Unlock()
	a.Sweep(context.Background(), time.Now().Add(4*time.Minute))
	if b.stops != 0 {
		t.Fatal("grace shortened")
	}
	a.Sweep(context.Background(), time.Now().Add(6*time.Minute))
	if b.stops != 1 {
		t.Fatal("idle did not stop")
	}
}
func TestProxyIsolationAndCookieStripping(t *testing.T) {
	a, _, u := testApp(t)
	token, _, _ := a.Store.NewSession(u)
	var gotPath, gotCookie string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Set-Cookie", "evil=1")
		io.WriteString(w, "stream")
	}))
	defer up.Close()
	a.Backend.(*fakeBackend).transport = redirectTransport{up.URL}
	w := request(a, "GET", "/browser/other-user/assets.js", "", token, "")
	if w.Code != 200 || gotPath != "/users/"+u.ID+"/browser/other-user/assets.js" || gotCookie != "" || w.Header().Get("Set-Cookie") != "" {
		t.Fatal(w.Code, gotPath, gotCookie, w.Header())
	}
}

type redirectTransport struct{ target string }

func (t redirectTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(t.target, "http://")
	return http.DefaultTransport.RoundTrip(r)
}
func TestWebSocketRevokedWhileConnected(t *testing.T) {
	a, _, u := testApp(t)
	token, _, _ := a.Store.NewSession(u)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, rw, e := w.(http.Hijacker).Hijack()
		if e != nil {
			return
		}
		defer c.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		rw.Flush()
		io.Copy(io.Discard, c)
	}))
	defer up.Close()
	a.Backend.(*fakeBackend).transport = redirectTransport{up.URL}
	a.Config.Local = true
	a.Config.Origin = "http://browser.test"
	a.activity[u.ID] = &tracked{Running: true}
	server := httptest.NewServer(a)
	defer server.Close()
	c, e := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	fmt.Fprintf(c, "GET /browser/ws HTTP/1.1\r\nHost: browser.test\r\nOrigin: http://browser.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: librebrowser_session=%s\r\n\r\n", token)
	reader := bufio.NewReader(c)
	line, e := reader.ReadString('\n')
	if e != nil || !strings.Contains(line, "101") {
		t.Fatal(line, e)
	}
	for {
		line, e = reader.ReadString('\n')
		if e != nil {
			t.Fatal(e)
		}
		if line == "\r\n" {
			break
		}
	}
	a.Store.Revoke(digest(token))
	c.SetReadDeadline(time.Now().Add(4 * time.Second))
	_, e = reader.ReadByte()
	if e == nil {
		t.Fatal("revoked socket remains readable")
	}
	if ne, ok := e.(net.Error); ok && ne.Timeout() {
		t.Fatal("revoked socket was not closed")
	}
}

func TestAdminAccountControlsRevokeAccess(t *testing.T) {
	a, admin, user := testApp(t)
	adminToken, adminCSRF, _ := a.Store.NewSession(admin)
	token, _, _ := a.Store.NewSession(user)
	action := func(name, value string) {
		t.Helper()
		w := request(a, "POST", "/api/admin/users/"+user.ID+"/"+name, `{"value":"`+value+`"}`, adminToken, adminCSRF)
		if w.Code != 204 {
			t.Fatal(name, w.Code, w.Body.String())
		}
	}
	action("role", "ADMIN")
	if _, e := a.Store.Session(token); e == nil {
		t.Fatal("role change did not revoke")
	}
	promoted, e := a.Store.Authenticate(user.Username, "long-test-password")
	if e != nil {
		t.Fatal(e)
	}
	token, _, _ = a.Store.NewSession(promoted)
	if w := request(a, "GET", "/api/admin/users", "", token, ""); w.Code != 200 {
		t.Fatal("promotion failed", w.Code)
	}
	action("role", "USER")
	action("password", "replacement-password")
	action("disabled", "true")
	if _, e := a.Store.Authenticate(user.Username, "replacement-password"); e == nil {
		t.Fatal("disabled user signed in")
	}
	action("disabled", "false")
	enabled, e := a.Store.Authenticate(user.Username, "replacement-password")
	if e != nil {
		t.Fatal(e)
	}
	token, _, _ = a.Store.NewSession(enabled)
	action("delete", "")
	if _, e := a.Store.Session(token); e == nil {
		t.Fatal("deleted user session active")
	}
}

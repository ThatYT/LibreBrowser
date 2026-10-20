package libre

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func domTestApp(t *testing.T) (*App, User, User) {
	t.Helper()
	a, admin, user := testApp(t)
	a.Config.Engine = "dom"
	a.Config.RendererOrigin = "https://render.browser.test"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Libre-Engine-Token") != "" {
			t.Error("client credentials reached broker", r.Header)
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
		w.Header().Set("Set-Cookie", "untrusted=1")
		if strings.Contains(r.URL.Path, "/a/") {
			w.Header().Set("Content-Type", "text/html")
		}
		io.WriteString(w, "ok")
	}))
	t.Cleanup(upstream.Close)
	a.Backend.(*fakeBackend).transport = redirectTransport{upstream.URL}
	return a, admin, user
}
func rendererRequest(a *App, method, path, body, cookie, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, a.Config.RendererOrigin+path, strings.NewReader(body))
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: a.viewerCookieName(), Value: cookie})
	}
	w := httptest.NewRecorder()
	a.ServeRenderer(w, r)
	return w
}
func viewerTicket(t *testing.T, a *App, u User) (string, string, string) {
	t.Helper()
	token, csrf, err := a.Store.NewSession(u)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Start(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	w := request(a, "POST", "/api/browser/viewer", "{}", token, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body struct{ URL string }
	json.Unmarshal(w.Body.Bytes(), &body)
	parsed, _ := url.Parse(body.URL)
	return parsed.Fragment, token, csrf
}
func joinViewer(t *testing.T, a *App, ticket string) string {
	t.Helper()
	w := rendererRequest(a, "POST", "/join", `{"ticket":"`+ticket+`"}`, "", a.Config.RendererOrigin)
	if w.Code != 204 || len(w.Result().Cookies()) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.Domain != "" || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe viewer cookie", cookie)
	}
	return cookie.Value
}
func TestRendererSingleUseAndAccountBoundary(t *testing.T) {
	a, _, u := domTestApp(t)
	ticket, token, csrf := viewerTicket(t, a, u)
	if w := request(a, "POST", "/api/browser/viewer", "{}", token, ""); w.Code != 403 {
		t.Fatal("viewer issue without CSRF", w.Code)
	}
	if w := rendererRequest(a, "POST", "/join", `{"ticket":"`+ticket+`"}`, "", "https://evil.test"); w.Code != 403 {
		t.Fatal("cross-origin join", w.Code)
	}
	cookie := joinViewer(t, a, ticket)
	if w := rendererRequest(a, "POST", "/join", `{"ticket":"`+ticket+`"}`, "", a.Config.RendererOrigin); w.Code != 403 {
		t.Fatal("ticket reused", w.Code)
	}
	for _, path := range []string{"/api/me", "/api/admin/users", "/s/another-user/a/token", "/__e2e/evaluate", "/join/extra"} {
		if w := rendererRequest(a, "GET", path, "", cookie, ""); w.Code != 404 {
			t.Fatal("renderer route exposed", path, w.Code)
		}
	}
	if w := request(a, "GET", "/api/admin/users", "", cookie, ""); w.Code != 401 {
		t.Fatal("viewer granted account access", w.Code)
	}
	w := rendererRequest(a, "GET", "/", "", cookie, "")
	if w.Code != 200 || w.Header().Get("Set-Cookie") != "" || !strings.Contains(w.Header().Get("Content-Security-Policy"), a.Config.Origin) {
		t.Fatal(w.Code, w.Header())
	}
	if w := rendererRequest(a, "GET", "/s/"+u.ID+"/a/opaque-token", "", cookie, ""); w.Code != 415 {
		t.Fatal("HTML asset executable", w.Code)
	}
	if w := request(a, "GET", "/browser/", "", token, ""); w.Code != 404 {
		t.Fatal("DOM served on trusted app origin", w.Code)
	}
	if w := request(a, "POST", "/api/logout", "{}", token, csrf); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if w := rendererRequest(a, "GET", "/", "", cookie, ""); w.Code != 401 {
		t.Fatal("logout did not revoke viewer", w.Code)
	}
}
func TestRendererStopsAndDoesNotReuseOldGrants(t *testing.T) {
	a, _, u := domTestApp(t)
	ticket, token, csrf := viewerTicket(t, a, u)
	cookie := joinViewer(t, a, ticket)
	other, _, _ := viewerTicket(t, a, u)
	if w := request(a, "POST", "/api/browser/stop", "{}", token, csrf); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if err := a.Start(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if w := rendererRequest(a, "GET", "/", "", cookie, ""); w.Code != 401 {
		t.Fatal("old run reattached", w.Code)
	}
	if w := rendererRequest(a, "POST", "/join", `{"ticket":"`+other+`"}`, "", a.Config.RendererOrigin); w.Code != 403 {
		t.Fatal("stopped run ticket accepted", w.Code)
	}
}
func TestRendererGrantExpiryAndTwoUsers(t *testing.T) {
	a, admin, u := domTestApp(t)
	ticket, _, _ := viewerTicket(t, a, u)
	cookie := joinViewer(t, a, ticket)
	ticket2, _, _ := viewerTicket(t, a, admin)
	cookie2 := joinViewer(t, a, ticket2)
	if w := rendererRequest(a, "GET", "/s/"+admin.ID+"/d/secret", "", cookie, ""); w.Code != 404 {
		t.Fatal("cross-user download", w.Code)
	}
	if err := a.Stop(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if w := rendererRequest(a, "GET", "/", "", cookie2, ""); w.Code != 200 {
		t.Fatal("other user stopped", w.Code)
	}
	ticket3, _, _ := viewerTicket(t, a, admin)
	a.renderMu.Lock()
	g := a.tickets[digest(ticket3)]
	g.TicketExpires = time.Now().Add(-time.Second).Unix()
	a.tickets[digest(ticket3)] = g
	a.renderMu.Unlock()
	if w := rendererRequest(a, "POST", "/join", `{"ticket":"`+ticket3+`"}`, "", a.Config.RendererOrigin); w.Code != 403 {
		t.Fatal("expired ticket accepted", w.Code)
	}
}
func TestDOMConfigRequiresSeparateOrigin(t *testing.T) {
	t.Setenv("BROWSER_ENGINE", "dom")
	t.Setenv("PUBLIC_ORIGIN", "https://browser.test")
	t.Setenv("RENDERER_ORIGIN", "https://browser.test:8091")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("same production hostname accepted")
	}
	t.Setenv("RENDERER_ORIGIN", "https://render.browser.test")
	t.Setenv("BROWSER_IDLE_MINUTES", "10")
	c, err := LoadConfig()
	if err != nil || c.Grace != 10*time.Minute {
		t.Fatal(c, err)
	}
}

func TestRendererWebSocketRevocationAndStop(t *testing.T) {
	for _, action := range []string{"logout", "stop"} {
		t.Run(action, func(t *testing.T) {
			a, _, u := testApp(t)
			a.Config.Engine = "dom"
			a.Config.Local = true
			a.Config.Origin = "http://browser.test"
			a.Config.RendererOrigin = "http://render.browser.test"
			login, _, _ := a.Store.NewSession(u)
			i, _ := a.Store.Session(login)
			a.activity[u.ID] = &tracked{Running: true, Run: Token()}
			token := Token()
			a.viewers[digest(token)] = viewerGrant{ID: u.ID, SessionHash: i.TokenHash, Run: a.activity[u.ID].Run, Expires: i.Expires}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				c, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer c.Close()
				rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
				rw.Flush()
				io.Copy(io.Discard, c)
			}))
			defer upstream.Close()
			a.Backend.(*fakeBackend).transport = redirectTransport{upstream.URL}
			server := httptest.NewServer(http.HandlerFunc(a.ServeRenderer))
			defer server.Close()
			conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: render.browser.test\r\nOrigin: http://render.browser.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: librebrowser_viewer=%s\r\n\r\n", token)
			reader := bufio.NewReader(conn)
			line, err := reader.ReadString('\n')
			if err != nil || !strings.Contains(line, "101") {
				t.Fatal(line, err)
			}
			for {
				line, err = reader.ReadString('\n')
				if err != nil {
					t.Fatal(err)
				}
				if line == "\r\n" {
					break
				}
			}
			if action == "logout" {
				a.Store.Revoke(i.TokenHash)
			} else {
				a.Stop(context.Background(), u.ID)
			}
			conn.SetReadDeadline(time.Now().Add(4 * time.Second))
			_, err = reader.ReadByte()
			if err == nil {
				t.Fatal("revoked viewer still readable")
			}
			if e, ok := err.(net.Error); ok && e.Timeout() {
				t.Fatal("revoked viewer socket remained open")
			}
		})
	}
}

func TestRendererHostnameDispatchKeepsAccountsOnTrustedOrigin(t *testing.T) {
	a, _, _ := domTestApp(t)
	for _, path := range []string{"/", "/api/me", "/admin/users"} {
		r := httptest.NewRequest("GET", a.Config.RendererOrigin+path, nil)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code == http.StatusOK || strings.Contains(w.Body.String(), "<html") {
			t.Fatalf("renderer exposed account route %s: %d", path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", a.Config.RendererOrigin+"/join.js", nil)
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("renderer hostname did not dispatch join script: %d", w.Code)
	}
}

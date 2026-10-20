package libre

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"time"
)

type viewerGrant struct {
	ID, SessionHash, Run   string
	Expires, TicketExpires int64
}

// Caller holds a.mu; renderer handlers never hold renderMu while taking a.mu.
func (a *App) dropViewerGrants(id string) {
	a.renderMu.Lock()
	defer a.renderMu.Unlock()
	for k, g := range a.tickets {
		if g.ID == id {
			delete(a.tickets, k)
		}
	}
	for k, g := range a.viewers {
		if g.ID == id {
			delete(a.viewers, k)
		}
	}
}

func (a *App) viewerCookieName() string {
	if a.Config.Local {
		return "librebrowser_viewer"
	}
	return "__Host-librebrowser_viewer"
}

// A grant is tied to BOTH a revocable login session and a specific browser run.
func (a *App) validateViewer(g viewerGrant) (Identity, error) {
	if time.Now().Unix() >= g.Expires {
		return Identity{}, ErrDenied
	}
	i, err := a.Store.SessionHash(g.SessionHash)
	if err != nil || i.ID != g.ID {
		return Identity{}, ErrDenied
	}
	a.mu.Lock()
	t := a.activity[g.ID]
	valid := t != nil && t.Running && t.Run == g.Run
	a.mu.Unlock()
	if !valid {
		return Identity{}, ErrDenied
	}
	return i, nil
}

func (a *App) issueViewer(w http.ResponseWriter, r *http.Request, i Identity) {
	// Do not hand the UI a viewer until Chromium and the engine are accepting requests.
	req, _ := http.NewRequestWithContext(r.Context(), "GET", "http://broker/users/"+i.ID+"/render/healthz", nil)
	res, err := a.Backend.Proxy().RoundTrip(req)
	if err != nil {
		http.Error(w, "engine starting", 503)
		return
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	if res.StatusCode != 200 {
		http.Error(w, "engine starting", 503)
		return
	}
	a.mu.Lock()
	t := a.activity[i.ID]
	if t == nil || !t.Running {
		a.mu.Unlock()
		http.Error(w, "browser stopped", 409)
		return
	}
	g := viewerGrant{ID: i.ID, SessionHash: i.TokenHash, Run: t.Run, Expires: i.Expires, TicketExpires: time.Now().Add(time.Minute).Unix()}
	a.mu.Unlock()
	ticket := Token()
	a.renderMu.Lock()
	now := time.Now().Unix()
	for k, v := range a.tickets {
		if v.TicketExpires <= now {
			delete(a.tickets, k)
		}
	}
	for k, v := range a.viewers {
		if v.Expires <= now {
			delete(a.viewers, k)
		}
	}
	if len(a.tickets) >= 2048 || len(a.viewers) >= 2048 {
		a.renderMu.Unlock()
		http.Error(w, "viewer limit reached", 429)
		return
	}
	a.tickets[digest(ticket)] = g
	a.renderMu.Unlock()
	jsonReply(w, 200, map[string]string{"url": a.Config.RendererOrigin + "/join#" + ticket})
}

func (a *App) ServeRenderer(w http.ResponseWriter, r *http.Request) {
	origin, _ := url.Parse(a.Config.RendererOrigin)
	if origin == nil || !strings.EqualFold(r.Host, origin.Host) {
		http.Error(w, "renderer host required", 400)
		return
	}
	if !a.Config.Local && r.TLS == nil && (!a.trusted(r) || r.Header.Get("X-Forwarded-Proto") != "https") {
		http.Error(w, "HTTPS required", 400)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// No account APIs or trusted shell assets are reachable on this listener.
	ancestors := "frame-ancestors 'self' " + a.Config.Origin
	if r.URL.Path == "/join" || r.URL.Path == "/join.js" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; "+ancestors)
		if r.Method == "GET" && r.URL.Path == "/join.js" {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			io.WriteString(w, `'use strict';(async()=>{const token=location.hash.slice(1);history.replaceState(null,'','/join'+location.search);try{const r=await fetch('/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:token}),credentials:'same-origin'});if(!r.ok)throw Error();location.replace('/'+location.search);}catch{document.body.textContent='Viewer expired. Reconnect from LibreBrowser. / 请返回 LibreBrowser 重新连接。';}})();`)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/join" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><title>LibreBrowser</title><script src="/join.js" defer></script></head><body>Connecting… / 正在连接…</body></html>`)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/join" {
			if r.Header.Get("Origin") != a.Config.RendererOrigin {
				http.Error(w, "origin required", 403)
				return
			}
			var body struct {
				Ticket string `json:"ticket"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&body) != nil || len(body.Ticket) != 64 {
				http.Error(w, "invalid viewer ticket", 403)
				return
			}
			a.renderMu.Lock()
			g, ok := a.tickets[digest(body.Ticket)]
			delete(a.tickets, digest(body.Ticket)) // Single use, including invalidated grants.
			a.renderMu.Unlock()
			if !ok || g.TicketExpires <= time.Now().Unix() {
				http.Error(w, "viewer expired", 403)
				return
			}
			if _, err := a.validateViewer(g); err != nil {
				http.Error(w, "viewer expired", 403)
				return
			}
			token := Token()
			a.renderMu.Lock()
			a.viewers[digest(token)] = g
			a.renderMu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: a.viewerCookieName(), Value: token, Path: "/", HttpOnly: true, Secure: !a.Config.Local, SameSite: http.SameSiteStrictMode, MaxAge: int(g.Expires - time.Now().Unix())})
			w.WriteHeader(204)
			return
		}
		http.NotFound(w, r)
		return
	}
	cookie, err := r.Cookie(a.viewerCookieName())
	if err != nil || len(cookie.Value) != 64 {
		http.Error(w, "viewer authentication required", 401)
		return
	}
	a.renderMu.Lock()
	g, ok := a.viewers[digest(cookie.Value)]
	a.renderMu.Unlock()
	if !ok {
		http.Error(w, "viewer authentication required", 401)
		return
	}
	i, err := a.validateViewer(g)
	if err != nil {
		http.Error(w, "viewer expired", 401)
		return
	}
	ws := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if (ws || r.Method != "GET" && r.Method != "HEAD") && r.Header.Get("Origin") != a.Config.RendererOrigin {
		http.Error(w, "renderer origin required", 403)
		return
	}
	p := r.URL.Path
	if path.Clean(p) != p || strings.Contains(p, "\\") {
		http.NotFound(w, r)
		return
	}
	resource := strings.HasPrefix(p, "/s/"+g.ID+"/a/") || strings.HasPrefix(p, "/s/"+g.ID+"/d/")
	upload := strings.HasPrefix(p, "/s/"+g.ID+"/u/")
	static := p == "/" || strings.HasPrefix(p, "/assets/") || p == "/favicon.ico"
	if !((r.Method == "GET" || r.Method == "HEAD") && (static || resource || p == "/ws") || r.Method == "POST" && upload) {
		http.NotFound(w, r)
		return
	}
	if ws && p != "/ws" {
		http.Error(w, "invalid socket", 400)
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.Unix(i.Expires, 0))
	defer cancel()
	if ws {
		a.mu.Lock()
		t := a.activity[i.ID]
		if t == nil || !t.Running || t.Run != g.Run {
			a.mu.Unlock()
			http.Error(w, "browser stopped", 409)
			return
		}
		t.Connections++
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			if t := a.activity[i.ID]; t != nil && t.Run == g.Run {
				t.Connections--
				if t.Connections == 0 {
					t.LastIdle = time.Now()
				}
			}
			a.mu.Unlock()
		}()
		go func() {
			tick := time.NewTicker(time.Second)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					if _, err := a.validateViewer(g); err != nil {
						cancel()
						return
					}
				}
			}
		}()
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.Out.URL.Scheme = "http"
		pr.Out.URL.Host = "broker"
		pr.Out.Host = "broker"
		pr.Out.URL.Path = "/users/" + g.ID + "/render" + p
		pr.Out.URL.RawPath = ""
		for _, h := range []string{"Cookie", "Authorization", "X-CSRF-Token", "X-Libre-Engine-Token", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
			pr.Out.Header.Del(h)
		}
	}, Transport: closingTransport{a.Backend.Proxy()}, ModifyResponse: func(res *http.Response) error {
		res.Header.Del("Set-Cookie")
		res.Header.Del("X-Frame-Options")
		res.Header.Del("Cross-Origin-Opener-Policy")
		res.Header.Set("Cache-Control", "no-store")
		res.Header.Set("Referrer-Policy", "no-referrer")
		csp := res.Header.Get("Content-Security-Policy")
		if csp == "" {
			csp = "default-src 'self'; object-src 'none'; base-uri 'none'"
		}
		csp = strings.ReplaceAll(csp, "frame-ancestors 'none'", ancestors)
		if !strings.Contains(csp, "frame-ancestors") {
			csp += "; " + ancestors
		}
		res.Header.Set("Content-Security-Policy", csp)
		if strings.HasPrefix(p, "/s/"+g.ID+"/a/") {
			// An upstream Location must never redirect the client to a visited origin or LAN URL.
			if res.StatusCode >= 300 && res.StatusCode < 400 {
				res.Body.Close()
				res.Body = io.NopCloser(strings.NewReader("Asset redirect unavailable"))
				res.StatusCode = 502
				res.ContentLength = 26
				res.Header.Del("Location")
				res.Header.Del("Content-Length")
			}

			kind := strings.ToLower(strings.Split(res.Header.Get("Content-Type"), ";")[0])
			// Arbitrary HTML/JS/XML must never become executable documents on the renderer origin.
			if !(strings.HasPrefix(kind, "image/") || strings.HasPrefix(kind, "font/") || strings.HasPrefix(kind, "audio/") || strings.HasPrefix(kind, "video/") || kind == "text/css" || kind == "application/font-woff" || kind == "application/vnd.ms-fontobject" || kind == "application/octet-stream") {
				res.Body.Close()
				res.Body = io.NopCloser(strings.NewReader("Unsupported asset type"))
				res.StatusCode = 415
				res.ContentLength = 22
				res.Header.Del("Content-Length")
				res.Header.Del("Content-Encoding")
				res.Header.Del("Content-Range")
				res.Header.Set("Content-Type", "text/plain")
			}
			res.Header.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; "+ancestors)
		}
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "browser is starting or stopped", 503)
	}}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}

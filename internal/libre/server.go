package libre

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

//go:embed web/*
var assets embed.FS

type Backend interface {
	Command(context.Context, string, string) error
	Proxy() http.RoundTripper
}
type SocketBackend struct {
	Client    *http.Client
	Transport *http.Transport
}

func NewSocketBackend(path string) *SocketBackend {
	t := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", path)
	}, ResponseHeaderTimeout: 45 * time.Second}
	return &SocketBackend{&http.Client{Transport: t, Timeout: 90 * time.Second}, t}
}
func (b *SocketBackend) Command(ctx context.Context, id, action string) error {
	r, _ := http.NewRequestWithContext(ctx, "POST", "http://broker/users/"+id+"/"+action, nil)
	res, e := b.Client.Do(r)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		return errors.New("browser service unavailable; inspect broker logs")
	}
	return nil
}
func (b *SocketBackend) Proxy() http.RoundTripper { return b.Transport }
func (b *SocketBackend) Status(ctx context.Context, id string) (bool, error) {
	r, e := http.NewRequestWithContext(ctx, "GET", "http://broker/users/"+id+"/status", nil)
	if e != nil {
		return false, e
	}
	res, e := b.Client.Do(r)
	if e != nil {
		return false, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return false, errors.New("broker status unavailable")
	}
	var data struct{ Running bool }
	e = json.NewDecoder(res.Body).Decode(&data)
	return data.Running, e
}

type tracked struct {
	Run         string    `json:"-"`
	LastIdle    time.Time `json:"idle_since"`
	Connections int       `json:"connections"`
	Running     bool      `json:"running"`
}
type attempt struct {
	Count int
	Until time.Time
}
type App struct {
	Store     *Store
	Config    Config
	Backend   Backend
	mu        sync.Mutex
	accounts  sync.Mutex
	activity  map[string]*tracked
	attempts  map[string]attempt
	hashSlots chan struct{}
	renderMu  sync.Mutex
	tickets   map[string]viewerGrant
	viewers   map[string]viewerGrant
}

func NewApp(s *Store, c Config, b Backend) *App {
	return &App{Store: s, Config: c, Backend: b, activity: map[string]*tracked{}, attempts: map[string]attempt{}, hashSlots: make(chan struct{}, 2), tickets: map[string]viewerGrant{}, viewers: map[string]viewerGrant{}}
}
func (a *App) Start(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.Backend == nil {
		return errors.New("browser broker is unavailable")
	}
	if e := a.Backend.Command(ctx, id, "start"); e != nil {
		return e
	}
	t := a.activity[id]
	if t == nil {
		t = &tracked{}
		a.activity[id] = t
	}
	if !t.Running {
		t.Run = Token()
	}
	t.Running = true
	if t.Connections == 0 {
		t.LastIdle = time.Now()
	}
	return nil
}
func (a *App) Stop(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.Backend == nil {
		return errors.New("browser broker is unavailable")
	}
	if a.Config.Engine == "dom" {
		if t := a.activity[id]; t != nil {
			t.Run = Token()
			t.Connections = 0
			t.LastIdle = time.Now()
		}
		a.dropViewerGrants(id)
	}
	e := a.Backend.Command(ctx, id, "stop")
	if e == nil {
		if t := a.activity[id]; t != nil {
			t.Running = false
		}
	}
	return e
}
func (a *App) Sweep(ctx context.Context, now time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, t := range a.activity {
		if t.Running && t.Connections == 0 && now.Sub(t.LastIdle) >= a.Config.Grace {
			if e := a.Backend.Command(ctx, id, "stop"); e != nil {
				log.Printf("idle stop %s: %v", id, e)
			} else {
				delete(a.activity, id)
				if a.Config.Engine == "dom" {
					a.dropViewerGrants(id)
				}
			}
		}
	}
	for k, v := range a.attempts {
		if now.After(v.Until) {
			delete(a.attempts, k)
		}
	}
}
func (a *App) RunMaintenance(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if a.Backend != nil {
				heartbeat, cancel := context.WithTimeout(ctx, 10*time.Second)
				if e := a.Backend.Command(heartbeat, "all", "heartbeat"); e != nil {
					log.Printf("broker heartbeat: %v", e)
				}
				cancel()
			}
			a.Sweep(ctx, now)
		}
	}
}
func (a *App) trusted(r *http.Request) bool {
	h, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		return false
	}
	ip := net.ParseIP(h)
	for _, n := range a.Config.Trusted {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
func (a *App) gate(w http.ResponseWriter, r *http.Request) bool {
	origin, _ := url.Parse(a.Config.Origin)
	if r.Host != origin.Host {
		http.Error(w, "invalid host", 421)
		return false
	}
	if !a.Config.Local && r.TLS == nil && (!a.trusted(r) || r.Header.Get("X-Forwarded-Proto") != "https") {
		http.Error(w, "HTTPS required", 400)
		return false
	}
	if o := r.Header.Get("Origin"); o != "" && o != a.Config.Origin {
		http.Error(w, "invalid origin", 403)
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
		http.Error(w, "cross-site request denied", 403)
		return false
	}
	return true
}
func (a *App) cookieName() string {
	if a.Config.Local {
		return "librebrowser_session"
	}
	return "__Host-librebrowser_session"
}
func (a *App) identity(r *http.Request) (Identity, error) {
	c, e := r.Cookie(a.cookieName())
	if e != nil {
		return Identity{}, e
	}
	return a.Store.Session(c.Value)
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "JSON required", 415)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		http.Error(w, "invalid request", 400)
		return false
	}
	if d.Decode(&struct{}{}) != io.EOF {
		http.Error(w, "invalid request", 400)
		return false
	}
	return true
}
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if a.Config.Engine == "dom" {
		renderer, _ := url.Parse(a.Config.RendererOrigin)
		if renderer != nil && strings.EqualFold(r.Host, renderer.Host) {
			a.ServeRenderer(w, r)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	if !a.gate(w, r) {
		return
	}
	if r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "/account" || r.URL.Path == "/admin/users" || r.URL.Path == "/app.js" || r.URL.Path == "/style.css") {
		file := "index.html"
		kind := "text/html; charset=utf-8"
		if r.URL.Path == "/app.js" {
			file = "app.js"
			kind = "text/javascript; charset=utf-8"
		}
		if r.URL.Path == "/style.css" {
			file = "style.css"
			kind = "text/css"
		}
		frameSrc := "'self'"
		if a.Config.Engine == "dom" {
			frameSrc = "'self' " + a.Config.RendererOrigin
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-src "+frameSrc+"; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'")
		data, _ := assets.ReadFile("web/" + file)
		w.Header().Set("Content-Type", kind)
		w.Write(data)
		return
	}
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		w.Write([]byte("ok\n"))
		return
	}
	if r.URL.Path == "/api/login" && r.Method == "POST" {
		a.login(w, r)
		return
	}
	i, e := a.identity(r)
	if e != nil {
		http.Error(w, "authentication required", 401)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/browser/") {
		a.browser(w, r, i)
		return
	}
	if r.Method != "GET" {
		if r.Header.Get("Origin") != a.Config.Origin || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(i.CSRF)) != 1 {
			http.Error(w, "CSRF check failed", 403)
			return
		}
	}
	switch {
	case r.URL.Path == "/api/me" && r.Method == "GET":
		jsonReply(w, 200, map[string]any{"user": i.User, "csrf": i.CSRF, "engine": a.Config.Engine, "prototype": a.Config.Prototype})
	case r.URL.Path == "/api/logout" && r.Method == "POST":
		if e = a.Store.Revoke(i.TokenHash); e != nil {
			http.Error(w, "database error", 500)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Value: "", Path: "/", HttpOnly: true, Secure: !a.Config.Local, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		w.WriteHeader(204)
	case r.URL.Path == "/api/browser/start" && r.Method == "POST":
		if e = a.Start(r.Context(), i.ID); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
	case r.URL.Path == "/api/browser/viewer" && r.Method == "POST" && a.Config.Engine == "dom":
		a.issueViewer(w, r, i)
	case r.URL.Path == "/api/browser/stop" && r.Method == "POST":
		if e = a.Stop(r.Context(), i.ID); e != nil {
			http.Error(w, "could not stop browser", 503)
			return
		}
		w.WriteHeader(204)
	case r.URL.Path == "/api/account/password" && r.Method == "POST":
		a.password(w, r, i)
	case strings.HasPrefix(r.URL.Path, "/api/admin/"):
		if i.Role != "ADMIN" {
			http.Error(w, "administrator required", 403)
			return
		}
		a.admin(w, r, i)
	default:
		http.NotFound(w, r)
	}
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != a.Config.Origin {
		http.Error(w, "origin required", 403)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &body) {
		return
	}
	// RemoteAddr is the peer IP. Deliberately ignore client-controlled forwarding headers.
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	a.mu.Lock()
	now := time.Now()
	key := "ip:" + host
	v := a.attempts[key]
	if now.After(v.Until) {
		v = attempt{Until: now.Add(15 * time.Minute)}
	}
	global := a.attempts["global"]
	if now.After(global.Until) {
		global = attempt{Until: now.Add(time.Minute)}
	}
	v.Count++
	global.Count++
	a.attempts[key] = v
	a.attempts["global"] = global
	a.mu.Unlock()
	if v.Count > 10 || global.Count > 60 {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many attempts", 429)
		return
	}
	select {
	case a.hashSlots <- struct{}{}:
		defer func() { <-a.hashSlots }()
	default:
		http.Error(w, "try again shortly", 429)
		return
	}
	a.accounts.Lock()
	defer a.accounts.Unlock()
	u, e := a.Store.Authenticate(body.Username, body.Password)
	if e != nil {
		http.Error(w, "invalid credentials", 401)
		return
	}
	token, csrf, e := a.Store.NewSession(u)
	if e != nil {
		http.Error(w, "database error", 500)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: !a.Config.Local, SameSite: http.SameSiteStrictMode, MaxAge: 86400})
	jsonReply(w, 200, map[string]any{"user": u, "csrf": csrf, "engine": a.Config.Engine, "prototype": a.Config.Prototype})
}
func (a *App) password(w http.ResponseWriter, r *http.Request, i Identity) {
	var b struct {
		Current  string `json:"current_password"`
		Password string `json:"password"`
	}
	if !decode(w, r, &b) {
		return
	}
	a.accounts.Lock()
	defer a.accounts.Unlock()
	if _, e := a.Store.Authenticate(i.Username, b.Current); e != nil {
		http.Error(w, "current password incorrect", 403)
		return
	}
	if e := a.Store.Mutate(i.ID, "password", b.Password); e != nil {
		http.Error(w, e.Error(), 400)
		return
	}
	w.WriteHeader(204)
}
func (a *App) admin(w http.ResponseWriter, r *http.Request, i Identity) {
	if r.URL.Path == "/api/admin/users" && r.Method == "GET" {
		users, e := a.Store.Users()
		if e != nil {
			http.Error(w, "database error", 500)
			return
		}
		jsonReply(w, 200, users)
		return
	}
	if r.URL.Path == "/api/admin/status" && r.Method == "GET" {
		a.mu.Lock()
		snapshot := map[string]tracked{}
		for id, t := range a.activity {
			snapshot[id] = *t
		}
		a.mu.Unlock()
		users, e := a.Store.Users()
		if e != nil {
			http.Error(w, "database error", 500)
			return
		}
		status := map[string]any{}
		for _, u := range users {
			entry := snapshot[u.ID]
			available := true
			if backend, ok := a.Backend.(interface {
				Status(context.Context, string) (bool, error)
			}); ok {
				ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
				running, err := backend.Status(ctx, u.ID)
				cancel()
				available = err == nil
				entry.Running = running
			}
			status[u.ID] = struct {
				tracked
				Available bool `json:"available"`
			}{entry, available}
		}
		jsonReply(w, 200, status)
		return
	}
	a.accounts.Lock()
	defer a.accounts.Unlock()
	// Recheck roles under the mutation lock so concurrent demotion cannot retain privileges.
	current, e := a.identity(r)
	if e != nil || current.Role != "ADMIN" {
		http.Error(w, "administrator required", 403)
		return
	}
	if r.URL.Path == "/api/admin/users" && r.Method == "POST" {
		var b struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role"`
		}
		if !decode(w, r, &b) {
			return
		}
		if b.Role == "" {
			b.Role = "USER"
		}
		u, e := a.Store.Create(b.Username, b.Password, b.Role, false)
		if e != nil {
			http.Error(w, "invalid or existing account; use a 12–1024 byte password", 400)
			return
		}
		jsonReply(w, 201, u)
		return
	}
	p := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/users/"), "/")
	if len(p) != 2 || !idRE.MatchString(p[0]) || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	id, action := p[0], p[1]
	if action == "stop" {
		if e = a.Stop(r.Context(), id); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
		return
	}
	var b struct {
		Value string `json:"value"`
	}
	if !decode(w, r, &b) {
		return
	}
	if action == "delete" || action == "disabled" && b.Value == "true" {
		if e = a.Stop(r.Context(), id); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
	}
	if e = a.Store.Mutate(id, action, b.Value); e != nil {
		http.Error(w, e.Error(), 400)
		return
	}
	w.WriteHeader(204)
}

// Close upgraded upstream sockets when authentication is revoked, including CLI resets.
type closingTransport struct{ base http.RoundTripper }
type cancelBody struct {
	io.ReadCloser
	stop func() bool
}

func (b *cancelBody) Close() error                { b.stop(); return b.ReadCloser.Close() }
func (b *cancelBody) Write(p []byte) (int, error) { return b.ReadCloser.(io.Writer).Write(p) }
func (t closingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	res, e := t.base.RoundTrip(r)
	if e == nil && res.StatusCode == 101 {
		body := res.Body
		stop := context.AfterFunc(r.Context(), func() { body.Close() })
		res.Body = &cancelBody{body, stop}
	}
	return res, e
}
func (a *App) browser(w http.ResponseWriter, r *http.Request, i Identity) {
	if a.Config.Engine == "dom" {
		http.NotFound(w, r)
		return
	}
	if a.Backend == nil {
		http.Error(w, "browser unavailable", 503)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "browser method denied", 405)
		return
	}
	ws := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if ws && r.Header.Get("Origin") != a.Config.Origin {
		http.Error(w, "WebSocket origin required", 403)
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), time.Unix(i.Expires, 0))
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-tick.C:
				cookie, e := r.Cookie(a.cookieName())
				if e != nil {
					cancel()
					return
				}
				if _, e = a.Store.Session(cookie.Value); e != nil {
					cancel()
					return
				}
			}
		}
	}()
	if ws {
		a.mu.Lock()
		t := a.activity[i.ID]
		if t == nil {
			a.mu.Unlock()
			http.Error(w, "start browser first", 503)
			return
		}
		t.Connections++
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			if t := a.activity[i.ID]; t != nil {
				t.Connections--
				if t.Connections == 0 {
					t.LastIdle = time.Now()
				}
			}
			a.mu.Unlock()
		}()
	}
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.Out.URL.Scheme = "http"
		pr.Out.URL.Host = "broker"
		pr.Out.URL.Path = "/users/" + i.ID + "/browser/" + strings.TrimPrefix(pr.In.URL.Path, "/browser/")
		pr.Out.URL.RawPath = ""
		pr.Out.Host = "broker"
		pr.Out.Header.Del("Cookie")
		pr.Out.Header.Del("Authorization")
		pr.Out.Header.Del("X-CSRF-Token")
		pr.Out.Header.Del("Forwarded")
		pr.Out.Header.Del("X-Forwarded-For")
		pr.Out.Header.Del("X-Forwarded-Host")
		pr.Out.Header.Del("X-Forwarded-Proto")
	}, Transport: closingTransport{a.Backend.Proxy()}, ModifyResponse: func(res *http.Response) error {
		res.Header.Del("Set-Cookie")
		res.Header.Set("Cache-Control", "no-store")
		res.Header.Set("Content-Security-Policy", "frame-ancestors 'self'")
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) {
		http.Error(w, "browser is starting or unavailable", 503)
	}}
	proxy.ServeHTTP(w, r.WithContext(ctx))
}
func ServeApp(ctx context.Context, c Config) error {
	s, e := OpenStore(c.Database)
	if e != nil {
		return e
	}
	defer s.DB.Close()
	backend := NewSocketBackend(c.BrokerSocket)
	if e := backend.Command(ctx, "all", "recover"); e != nil {
		log.Printf("browser broker unavailable at startup: %v", e)
	}
	a := NewApp(s, c, backend)
	go a.RunMaintenance(ctx)
	server := &http.Server{Addr: c.Listen, Handler: a, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	go func() {
		<-ctx.Done()
		stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(stop)
	}()
	if c.Engine == "dom" && c.RendererListen != "off" {
		renderer := &http.Server{Addr: c.RendererListen, Handler: http.HandlerFunc(a.ServeRenderer), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
		go func() { <-ctx.Done(); renderer.Close() }()
		go func() {
			if err := renderer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("renderer listener: %v", err)
				server.Close()
			}
		}()
	}
	log.Printf("LibreBrowser listening on %s (origin %s)", c.Listen, c.Origin)
	return server.ListenAndServe()
}

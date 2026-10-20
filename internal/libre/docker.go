package libre

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const ownerLabel = "io.librebrowser.owner"
const domOwnerLabel = "io.librebrowser.dom-owner"
const brokerLabel = "io.librebrowser.broker"

// Playwright v1.56.1's Apache-2.0 Chromium seccomp profile. See engine/UPSTREAM.md.
//
//go:embed chromium-seccomp.json
var chromiumSeccomp string

var idRE = regexp.MustCompile(`^[a-f0-9]{32}$`)

type Docker struct{ client *http.Client }

func NewDocker(socket string) *Docker {
	return &Docker{&http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}, Timeout: 45 * time.Second}}
}
func (d *Docker) call(ctx context.Context, method, path string, in, out any) error {
	var b bytes.Buffer
	if in != nil {
		if e := json.NewEncoder(&b).Encode(in); e != nil {
			return e
		}
	}
	r, e := http.NewRequestWithContext(ctx, method, "http://docker/v1.48"+path, &b)
	if e != nil {
		return e
	}
	r.Header.Set("Content-Type", "application/json")
	res, e := d.client.Do(r)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("docker %s %s: %d %s", method, path, res.StatusCode, data)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

type DockerInspect struct {
	ID     string `json:"Id"`
	State  struct{ Running bool }
	Config struct {
		Labels map[string]string
		Env    []string
	}
	NetworkSettings struct {
		Networks map[string]struct{ IPAddress string }
	}
	HostConfig struct {
		RestartPolicy struct{ Name string }
		PortBindings  map[string]any
		Privileged    bool
		NetworkMode   string
	}
}
type Broker struct {
	D                         *Docker
	Image, Self, ServiceImage string
	Engine, DOMImage          string
	Memory, CPU, Pids         int64
	mu                        sync.Mutex
	leaseMu                   sync.Mutex
	lastLease                 time.Time
}

func NewBroker() *Broker {
	return &Broker{D: NewDocker(env("DOCKER_SOCKET", "/var/run/docker.sock")), Image: env("CHROMIUM_IMAGE", "lscr.io/linuxserver/chromium:latest"), Self: env("BROKER_CONTAINER", "librebrowser-broker"), ServiceImage: env("SERVICE_IMAGE", "librebrowser:local"), Memory: envInt("BROWSER_MEMORY", 2147483648), CPU: envInt("BROWSER_NANO_CPUS", 2000000000), Pids: envInt("BROWSER_PIDS", 512), Engine: env("BROWSER_ENGINE", "stream"), DOMImage: env("DOM_ENGINE_IMAGE", "librebrowser-dom-engine:local")}
}
func names(id string) (string, string, string, string) {
	return "lb-browser-" + id, "lb-egress-" + id, "lb-private-" + id, "lb-public-" + id
}
func (b *Broker) ownerKey() string {
	if b.Engine == "dom" {
		return domOwnerLabel
	}
	return ownerLabel
}
func (b *Broker) names(id string) (string, string, string, string) {
	if b.Engine == "dom" {
		prefix := "lb-dom-" + digest(b.Self)[:8] + "-"
		return prefix + "browser-" + id, prefix + "egress-" + id, prefix + "private-" + id, prefix + "public-" + id
	}
	return names(id)
}
func (b *Broker) labels(id string) map[string]string {
	labels := map[string]string{b.ownerKey(): id}
	if b.Engine == "dom" {
		labels[brokerLabel] = b.Self
	}
	return labels
}
func (b *Broker) domProfile(id string) string {
	return "lb-dom-" + digest(b.Self)[:8] + "-profile-" + id
}
func (b *Broker) inspect(ctx context.Context, name, id string) (DockerInspect, error) {
	var c DockerInspect
	e := b.D.call(ctx, "GET", "/containers/"+name+"/json", nil, &c)
	if e == nil && (c.Config.Labels[b.ownerKey()] != id || b.Engine == "dom" && c.Config.Labels[brokerLabel] != b.Self) {
		return c, ErrDenied
	}
	return c, e
}
func (b *Broker) ensureNetwork(ctx context.Context, name, id string, internal bool) error {
	var n struct {
		Internal        bool
		Labels, Options map[string]string
	}
	e := b.D.call(ctx, "GET", "/networks/"+name, nil, &n)
	if e == nil {
		if n.Labels[b.ownerKey()] != id || b.Engine == "dom" && n.Labels[brokerLabel] != b.Self || n.Internal != internal || (internal && n.Options["com.docker.network.bridge.gateway_mode_ipv4"] != "isolated") {
			return ErrDenied
		}
		return nil
	}
	opts := map[string]string{}
	if internal {
		opts["com.docker.network.bridge.gateway_mode_ipv4"] = "isolated"
	}
	return b.D.call(ctx, "POST", "/networks/create", map[string]any{"Name": name, "Driver": "bridge", "Internal": internal, "EnableIPv6": false, "Options": opts, "Labels": b.labels(id)}, nil)
}
func (b *Broker) Start(ctx context.Context, id string) error {
	if !idRE.MatchString(id) {
		return ErrDenied
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	browser, egress, private, public := b.names(id)
	if e := b.ensureNetwork(ctx, private, id, true); e != nil {
		return e
	}
	if e := b.ensureNetwork(ctx, public, id, false); e != nil {
		return e
	}
	// Broker listens on a Unix socket only; attaching permits streaming without host port publication.
	var self DockerInspect
	if e := b.D.call(ctx, "GET", "/containers/"+b.Self+"/json", nil, &self); e != nil {
		return e
	}
	if _, ok := self.NetworkSettings.Networks[private]; !ok {
		if e := b.D.call(ctx, "POST", "/networks/"+private+"/connect", map[string]any{"Container": b.Self}, nil); e != nil {
			return e
		}
	}
	c, e := b.inspect(ctx, egress, id)
	if e != nil {
		spec := map[string]any{"Image": b.ServiceImage,
			"Cmd": []string{"egress"},
			"Env": []string{"EGRESS_DENY_CIDRS=" + env("EGRESS_DENY_CIDRS", ""),
				"EGRESS_UPSTREAM_SOCKET=" + env("EGRESS_UPSTREAM_SOCKET", "")},
			"User":   "65532:65532",
			"Labels": b.labels(id),
			"HostConfig": map[string]any{"NetworkMode": public,
				"ReadonlyRootfs": true,
				"Sysctls": map[string]string{"net.ipv4.ip_forward": "0",
					"net.ipv6.conf.all.forwarding": "0"},
				"CapDrop":       []string{"ALL"},
				"SecurityOpt":   []string{"no-new-privileges:true"},
				"Memory":        134217728,
				"NanoCpus":      500000000,
				"PidsLimit":     64,
				"RestartPolicy": map[string]string{"Name": "no"}},
			"NetworkingConfig": map[string]any{"EndpointsConfig": map[string]any{public: map[string]any{},
				private: map[string]any{}}}}
		if socket := env("EGRESS_UPSTREAM_SOCKET", ""); socket != "" {
			// This volume contains only the host uplink socket. Browsers never mount it.
			volume := env("EGRESS_UPSTREAM_VOLUME", "")
			if socket != "/run/librebrowser-uplink/proxy.sock" || volume != "librebrowser-v2raya-uplink" {
				return errors.New("invalid egress uplink volume configuration")
			}
			spec["HostConfig"].(map[string]any)["Mounts"] = []map[string]any{{"Type": "volume", "Source": volume, "Target": "/run/librebrowser-uplink", "ReadOnly": true}}
		}
		if e = b.D.call(ctx, "POST", "/containers/create?name="+egress, spec, nil); e != nil {
			return e
		}
		c, e = b.inspect(ctx, egress, id)
		if e != nil {
			return e
		}
	}
	if !c.State.Running {
		if e = b.D.call(ctx, "POST", "/containers/"+egress+"/start", nil, nil); e != nil {
			return e
		}
	}
	c, e = b.inspect(ctx, egress, id)
	if e != nil {
		return e
	}
	ip := c.NetworkSettings.Networks[private].IPAddress
	if net.ParseIP(ip) == nil {
		return errors.New("egress network missing")
	}
	if b.Engine == "dom" {
		return b.startDOM(ctx, id, private, ip)
	}
	c, e = b.inspect(ctx, browser, id)
	if e != nil {
		volume := "lb-profile-" + id
		var vol struct{ Labels map[string]string }
		if err := b.D.call(ctx, "GET", "/volumes/"+volume, nil, &vol); err == nil && vol.Labels[b.ownerKey()] != id {
			return ErrDenied
		}
		if e = b.D.call(ctx, "POST", "/volumes/create", map[string]any{"Name": volume, "Labels": b.labels(id)}, nil); e != nil {
			return e
		}
		spec := map[string]any{"Image": b.Image,
			"Labels": b.labels(id),
			"Env": []string{"PUID=1000",
				"PGID=1000",
				"TZ=UTC",
				"SUBFOLDER=/browser/",
				"HARDEN_DESKTOP=true",
				"HARDEN_OPENBOX=true",
				"DISABLE_SUDO=true",
				"DISABLE_TERMINALS=true",
				"START_DOCKER=false",
				"SELKIES_COMMAND_ENABLED=false|locked",
				"SELKIES_FILE_TRANSFERS=none|locked",
				"SELKIES_ENABLE_SHARING=false|locked",
				"SELKIES_MODE=websockets",
				"SELKIES_ENABLE_DUAL_MODE=false|locked",
				"SELKIES_PRINTING_ENABLED=false|locked",
				"SELKIES_ENABLE_COLLAB=false|locked",
				"SELKIES_ENABLE_SHARED=false|locked",
				"SELKIES_UI_SIDEBAR_SHOW_APPS=false|locked",
				"SELKIES_UI_SIDEBAR_SHOW_FILES=false|locked",
				"SELKIES_USE_BROWSER_CURSORS=true",
				// Follow the viewport aspect ratio to avoid letterboxing; keep 30 FPS and bounded traffic.
				"SELKIES_USE_CSS_SCALING=true|locked",
				"SELKIES_MANUAL_RESOLUTION=false|locked",
				"SELKIES_MANUAL_WIDTH=0",
				"SELKIES_MANUAL_HEIGHT=0",
				"SELKIES_ENABLE_RESIZE=true|locked",
				"SELKIES_FRAMERATE=30-30",
				"SELKIES_RATE_CONTROL_MODE=cbr|locked",
				"SELKIES_VIDEO_BITRATE=6000,500-6000",
				"CHROME_CLI=--proxy-server=http://" + net.JoinHostPort(ip,
					"3128") + " --proxy-bypass-list=<-loopback> --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp",
				"http_proxy=http://" + net.JoinHostPort(ip,
					"3128"),
				"https_proxy=http://" + net.JoinHostPort(ip,
					"3128")},
			"HostConfig": map[string]any{"NetworkMode": private,
				"Mounts": []map[string]any{{"Type": "volume",
					"Source": volume,
					"Target": "/config"}},
				"Memory":     b.Memory,
				"MemorySwap": b.Memory,
				"NanoCpus":   b.CPU,
				"PidsLimit":  b.Pids,
				"ShmSize":    536870912,
				"CapDrop": []string{"NET_RAW",
					"NET_ADMIN",
					"SYS_ADMIN"},
				"SecurityOpt":   []string{"no-new-privileges:true"},
				"RestartPolicy": map[string]string{"Name": "no"},
				"Dns":           []string{"127.0.0.1"}}}
		if e = b.D.call(ctx, "POST", "/containers/create?name="+browser, spec, nil); e != nil {
			return e
		}
		c, e = b.inspect(ctx, browser, id)
		if e != nil {
			return e
		}
	}
	if !c.State.Running {
		return b.D.call(ctx, "POST", "/containers/"+browser+"/start", nil, nil)
	}
	return nil
}
func (b *Broker) Stop(ctx context.Context, id string, remove bool) error {
	if !idRE.MatchString(id) {
		return ErrDenied
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	browser, egress, _, _ := b.names(id)
	remove = remove || b.Engine == "dom" // Retain volumes, release all engine/container resources.
	var failures []error
	for _, name := range []string{browser, egress} {
		c, e := b.inspect(ctx, name, id)
		if e != nil {
			if strings.Contains(e.Error(), ": 404 ") {
				continue
			}
			failures = append(failures, e)
			continue
		}
		if c.State.Running {
			if name == browser && b.Engine != "dom" {
				if err := b.flushChromium(ctx, name); err != nil {
					log.Printf("Chromium graceful exit %s: %v", id, err)
				}
			}
			if e = b.D.call(ctx, "POST", "/containers/"+name+"/stop?t=30", nil, nil); e != nil {
				failures = append(failures, e)
				continue
			}
		}
		if remove {
			if e = b.D.call(ctx, "DELETE", "/containers/"+name, nil, nil); e != nil {
				failures = append(failures, e)
			}
		}
	}
	if b.Engine == "dom" && len(failures) == 0 {
		_, _, private, public := b.names(id)
		for _, network := range []string{private, public} {
			var n struct{ Labels map[string]string }
			if err := b.D.call(ctx, "GET", "/networks/"+network, nil, &n); err != nil {
				if !strings.Contains(err.Error(), ": 404 ") {
					failures = append(failures, err)
				}
				continue
			}
			if n.Labels[domOwnerLabel] != id || n.Labels[brokerLabel] != b.Self {
				failures = append(failures, ErrDenied)
				continue
			}
			if network == private {
				if err := b.D.call(ctx, "POST", "/networks/"+network+"/disconnect", map[string]any{"Container": b.Self, "Force": true}, nil); err != nil {
					failures = append(failures, err)
					continue
				}
			}
			if err := b.D.call(ctx, "DELETE", "/networks/"+network, nil, nil); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

// Stop the upstream restart watchdog, then let the main Chromium process flush its profile.
// The exec operation is fixed and only called after container ownership was verified.
func (b *Broker) flushChromium(ctx context.Context, name string) error {
	const script = `/command/s6-svc -d /run/service/svc-watchdog 2>/dev/null || true
pid=$(pgrep -o -u 1000 -x chromium || true)
if [ -n "$pid" ]; then
 kill -TERM "$pid" 2>/dev/null || true
 i=0
 while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
fi`
	var exec struct {
		ID string `json:"Id"`
	}
	if e := b.D.call(ctx, "POST", "/containers/"+name+"/exec", map[string]any{"User": "0:0", "Cmd": []string{"/bin/sh", "-c", script}}, &exec); e != nil {
		return e
	}
	if e := b.D.call(ctx, "POST", "/exec/"+exec.ID+"/start", map[string]bool{"Detach": true, "Tty": false}, nil); e != nil {
		return e
	}
	for n := 0; n < 70; n++ {
		var state struct {
			Running  bool
			ExitCode int
		}
		if e := b.D.call(ctx, "GET", "/exec/"+exec.ID+"/json", nil, &state); e != nil {
			return e
		}
		if !state.Running {
			if state.ExitCode != 0 {
				return fmt.Errorf("graceful exit status %d", state.ExitCode)
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return errors.New("Chromium exit deadline reached; falling back to Docker stop")
}
func (b *Broker) Recover(ctx context.Context) error {
	var cs []struct{ Labels map[string]string }
	labels := []string{b.ownerKey()}
	if b.Engine == "dom" {
		labels = append(labels, brokerLabel+"="+b.Self)
	}
	encoded, _ := json.Marshal(map[string]any{"label": labels})
	filters := url.QueryEscape(string(encoded))
	if e := b.D.call(ctx, "GET", "/containers/json?all=true&filters="+filters, nil, &cs); e != nil {
		return e
	}
	ids := map[string]bool{}
	for _, c := range cs {
		if id := c.Labels[b.ownerKey()]; idRE.MatchString(id) {
			ids[id] = true
		}
	}
	for id := range ids {
		if e := b.Stop(ctx, id, false); e != nil {
			return e
		}
	}
	return nil
}
func (b *Broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/users/all/heartbeat" && r.Method == "POST" {
		b.leaseMu.Lock()
		b.lastLease = time.Now()
		b.leaseMu.Unlock()
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == "/users/all/recover" && r.Method == "POST" {
		if e := b.Recover(r.Context()); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/users/"), "/", 2)
	if len(parts) != 2 || !idRE.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	id, action := parts[0], parts[1]
	switch {
	case action == "start" && r.Method == "POST":
		if e := b.Start(r.Context(), id); e != nil {
			if b.Engine == "dom" {
				cleanup, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Minute)
				if stopErr := b.Stop(cleanup, id, false); stopErr != nil {
					log.Printf("failed startup cleanup: %v", stopErr)
				}
				cancel()
			}
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
	case action == "stop" && r.Method == "POST":
		if e := b.Stop(r.Context(), id, false); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
	case action == "remove" && r.Method == "POST":
		if e := b.Stop(r.Context(), id, true); e != nil {
			http.Error(w, e.Error(), 503)
			return
		}
		w.WriteHeader(204)
	case action == "status" && r.Method == "GET":
		name, _, _, _ := b.names(id)
		c, e := b.inspect(r.Context(), name, id)
		running := e == nil && c.State.Running
		json.NewEncoder(w).Encode(map[string]bool{"running": running})
	case strings.HasPrefix(action, "render/") && b.Engine == "dom":
		b.proxyDOM(w, r, id, strings.TrimPrefix(action, "render/"))
	case strings.HasPrefix(action, "browser/") && b.Engine != "dom":
		name, _, private, _ := b.names(id)
		c, e := b.inspect(r.Context(), name, id)
		if e != nil || !c.State.Running {
			http.Error(w, "browser stopped", 503)
			return
		}
		ip := c.NetworkSettings.Networks[private].IPAddress
		if net.ParseIP(ip) == nil {
			http.Error(w, "missing network", 503)
			return
		}
		target := &url.URL{Scheme: "http", Host: net.JoinHostPort(ip, "3000")}
		proxy := httputil.NewSingleHostReverseProxy(target)
		r.URL.Path = "/browser/" + strings.TrimPrefix(action, "browser/")
		r.URL.RawPath = ""
		proxy.ServeHTTP(w, r)
	default:
		http.NotFound(w, r)
	}
}
func ServeBroker(ctx context.Context) error {
	b := NewBroker()
	b.lastLease = time.Now()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b.leaseMu.Lock()
				stale := time.Since(b.lastLease) > 5*time.Minute
				b.leaseMu.Unlock()
				if stale {
					timeout, cancel := context.WithTimeout(ctx, 2*time.Minute)
					if e := b.Recover(timeout); e != nil {
						log.Printf("broker lease recovery: %v", e)
					}
					cancel()
					b.leaseMu.Lock()
					b.lastLease = time.Now()
					b.leaseMu.Unlock()
				}
			}
		}
	}()
	if e := b.Recover(ctx); e != nil {
		return fmt.Errorf("orphan recovery: %w", e)
	}
	path := env("BROKER_SOCKET", "/run/librebrowser/broker.sock")
	if e := os.MkdirAll(strings.TrimSuffix(path, "/broker.sock"), 0770); e != nil {
		return e
	}
	os.Remove(path)
	ln, e := net.Listen("unix", path)
	if e != nil {
		return e
	}
	defer ln.Close()
	if e = os.Chmod(path, 0660); e != nil {
		return e
	}
	server := &http.Server{Handler: b, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768}
	go func() {
		<-ctx.Done()
		server.Close()
	}()
	err := server.Serve(ln)
	cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if recoverErr := b.Recover(cleanup); recoverErr != nil {
		log.Printf("shutdown recovery: %v", recoverErr)
	}
	return err
}

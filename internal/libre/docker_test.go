package libre

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

type dockerMock struct {
	mu                            sync.Mutex
	containers, networks, volumes map[string]map[string]any
	running                       map[string]bool
	creates                       map[string]int
}

func (m *dockerMock) RoundTrip(r *http.Request) (*http.Response, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := strings.TrimPrefix(r.URL.Path, "/v1.48")
	var body map[string]any
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&body)
	}
	reply := func(status int, v any) (*http.Response, error) {
		data, _ := json.Marshal(v)
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	}
	if strings.HasSuffix(p, "/exec") && strings.HasPrefix(p, "/containers/") {
		return reply(201, map[string]string{"Id": "graceful-test"})
	}
	if p == "/exec/graceful-test/start" {
		return reply(204, nil)
	}
	if p == "/exec/graceful-test/json" {
		return reply(200, map[string]any{"Running": false, "ExitCode": 0})
	}
	if p == "/containers/self/json" {
		nets := map[string]any{}
		for n := range m.networks {
			nets[n] = map[string]string{"IPAddress": "172.22.0.3"}
		}
		return reply(200, map[string]any{"NetworkSettings": map[string]any{"Networks": nets}})
	}
	if p == "/networks/create" {
		m.networks[body["Name"].(string)] = body
		return reply(201, body)
	}
	if strings.HasPrefix(p, "/networks/") && strings.HasSuffix(p, "/disconnect") {
		return reply(200, nil)
	}
	if strings.HasPrefix(p, "/networks/") {
		if r.Method == "DELETE" {
			delete(m.networks, strings.TrimPrefix(p, "/networks/"))
			return reply(204, nil)
		}
		if n, ok := m.networks[strings.TrimPrefix(p, "/networks/")]; ok {
			return reply(200, n)
		}
		return reply(404, nil)
	}
	if p == "/volumes/create" {
		m.volumes[body["Name"].(string)] = body
		return reply(201, body)
	}
	if strings.HasPrefix(p, "/volumes/") {
		if v, ok := m.volumes[strings.TrimPrefix(p, "/volumes/")]; ok {
			return reply(200, v)
		}
		return reply(404, nil)
	}
	if p == "/containers/create" {
		n := r.URL.Query().Get("name")
		m.creates[n]++
		if _, ok := m.containers[n]; ok {
			return reply(409, nil)
		}
		m.containers[n] = body
		return reply(201, map[string]string{"Id": n})
	}
	if p == "/containers/json" {
		list := []map[string]any{}
		for _, v := range m.containers {
			list = append(list, map[string]any{"Labels": v["Labels"]})
		}
		return reply(200, list)
	}
	if strings.HasPrefix(p, "/containers/") {
		parts := strings.Split(strings.TrimPrefix(p, "/containers/"), "/")
		n := parts[0]
		spec, ok := m.containers[n]
		if !ok {
			return reply(404, nil)
		}
		if len(parts) == 1 && r.Method == "DELETE" {
			delete(m.containers, n)
			return reply(204, nil)
		}
		switch parts[1] {
		case "json":
			nets := map[string]any{}
			for name := range m.networks {
				nets[name] = map[string]string{"IPAddress": "172.22.0.2"}
			}
			return reply(200, map[string]any{"Config": map[string]any{"Labels": spec["Labels"]}, "State": map[string]bool{"Running": m.running[n]}, "NetworkSettings": map[string]any{"Networks": nets}})
		case "start":
			m.running[n] = true
			return reply(204, nil)
		case "stop":
			m.running[n] = false
			return reply(204, nil)
		}
	}
	return reply(500, p)
}
func mockBroker() (*Broker, *dockerMock) {
	m := &dockerMock{containers: map[string]map[string]any{}, networks: map[string]map[string]any{}, volumes: map[string]map[string]any{}, running: map[string]bool{}, creates: map[string]int{}}
	return &Broker{D: &Docker{client: &http.Client{Transport: m}}, Self: "self", Image: "lscr.io/linuxserver/chromium:test", ServiceImage: "librebrowser:test", Memory: 1 << 30, CPU: 1e9, Pids: 256}, m
}
func TestConcurrentDockerStartupAndHardening(t *testing.T) {
	b, m := mockBroker()
	id := Token()[:32]
	var wg sync.WaitGroup
	for n := 0; n < 12; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := b.Start(context.Background(), id); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	browser, egress, private, _ := names(id)
	if m.creates[browser] != 1 || m.creates[egress] != 1 {
		t.Fatal("duplicate containers", m.creates)
	}
	spec := m.containers[browser]
	h := spec["HostConfig"].(map[string]any)
	if h["NetworkMode"] != private || h["Memory"].(float64) != float64(1<<30) || h["PidsLimit"].(float64) != 256 {
		t.Fatal(h)
	}
	if _, ok := h["PortBindings"]; ok {
		t.Fatal("browser ports published")
	}
	if h["RestartPolicy"].(map[string]any)["Name"] != "no" {
		t.Fatal("automatic restart")
	}
	mount := h["Mounts"].([]any)[0].(map[string]any)
	if mount["Source"] != "lb-profile-"+id || mount["Target"] != "/config" {
		t.Fatal(mount)
	}
	data, _ := json.Marshal(spec)
	for _, expected := range []string{"HARDEN_DESKTOP=true", "DISABLE_SUDO=true", "DISABLE_TERMINALS=true", "SELKIES_COMMAND_ENABLED=false|locked", `--proxy-bypass-list=\u003c-loopback\u003e`} {
		if !strings.Contains(string(data), expected) {
			t.Fatal("missing", expected)
		}
	}
	if strings.Contains(string(data), "docker.sock") {
		t.Fatal("browser socket mount")
	}
	n := m.networks[private]
	if n["Internal"] != true || n["Options"].(map[string]any)["com.docker.network.bridge.gateway_mode_ipv4"] != "isolated" {
		t.Fatal("network isolation", n)
	}
}
func TestDockerRecoveryAndProfileReuse(t *testing.T) {
	b, m := mockBroker()
	id := Token()[:32]
	if e := b.Start(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	if e := b.Recover(context.Background()); e != nil {
		t.Fatal(e)
	}
	browser, egress, _, _ := names(id)
	if m.running[browser] || m.running[egress] {
		t.Fatal("orphans running")
	}
	if e := b.Start(context.Background(), id); e != nil {
		t.Fatal(e)
	}
	if m.creates[browser] != 1 || len(m.volumes) != 1 {
		t.Fatal("profile replaced")
	}
}
func TestDockerRejectsInvalidIDsAndForeignNetworks(t *testing.T) {
	b, m := mockBroker()
	for _, id := range []string{"../host", "admin", "", strings.Repeat("a", 64)} {
		if e := b.Start(context.Background(), id); e == nil {
			t.Fatal("invalid id accepted")
		}
	}
	id := Token()[:32]
	_, _, private, _ := names(id)
	m.networks[private] = map[string]any{"Internal": true, "Labels": map[string]string{ownerLabel: "foreign"}, "Options": map[string]string{"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}}
	if e := b.Start(context.Background(), id); e == nil {
		t.Fatal("foreign network adopted")
	}
}

func TestV2rayAUplinkIsMountedOnlyIntoEgress(t *testing.T) {
	t.Setenv("EGRESS_UPSTREAM_SOCKET", "/run/librebrowser-uplink/proxy.sock")
	t.Setenv("EGRESS_UPSTREAM_VOLUME", "librebrowser-v2raya-uplink")
	b, m := mockBroker()
	id := Token()[:32]
	if err := b.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	browser, egress, private, _ := names(id)
	spec := m.containers[egress]
	config := spec["HostConfig"].(map[string]any)
	mount := config["Mounts"].([]any)[0].(map[string]any)
	if mount["Source"] != "librebrowser-v2raya-uplink" || mount["ReadOnly"] != true {
		t.Fatal("incorrect uplink mount", mount)
	}
	if config["NetworkMode"] == "host" {
		t.Fatal("egress given host network")
	}
	data, _ := json.Marshal(m.containers[browser])
	if strings.Contains(string(data), "uplink") || m.containers[browser]["HostConfig"].(map[string]any)["NetworkMode"] != private {
		t.Fatal("browser has access to host uplink")
	}
}

func TestDOMContainerSandboxLifetimeAndProfile(t *testing.T) {
	b, m := mockBroker()
	b.Engine = "dom"
	b.DOMImage = "librebrowser-dom-engine:test"
	id := Token()[:32]
	if err := b.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	browser, egress, private, _ := b.names(id)
	spec := m.containers[browser]
	h := spec["HostConfig"].(map[string]any)
	data, _ := json.Marshal(spec)
	for _, bad := range []string{"--no-sandbox", "docker.sock", "PortBindings"} {
		if strings.Contains(string(data), bad) {
			t.Fatal("unsafe DOM container", bad)
		}
	}
	if h["CapAdd"] != nil || h["Privileged"] != nil {
		t.Fatal("unexpected privileges", h)
	}
	if spec["User"] != "1000:1000" || h["ReadonlyRootfs"] != true || h["NetworkMode"] != private {
		t.Fatal(spec)
	}
	security := h["SecurityOpt"].([]any)
	if !strings.HasPrefix(security[1].(string), "seccomp=") {
		t.Fatal("no namespace sandbox profile")
	}
	mount := h["Mounts"].([]any)[0].(map[string]any)
	if mount["Source"] != b.domProfile(id) || mount["Target"] != "/profile" {
		t.Fatal(mount)
	}
	if spec["Labels"].(map[string]any)[domOwnerLabel] != id {
		t.Fatal("DOM resources not separated from live stream broker")
	}
	if err := b.Stop(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	if m.containers[browser] != nil || m.containers[egress] != nil || len(m.volumes) != 1 {
		t.Fatal("engine resources retained or profile removed")
	}
	if err := b.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if len(m.volumes) != 1 || m.creates[browser] != 2 {
		t.Fatal("profile not reused on restart")
	}
}

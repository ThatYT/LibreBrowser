package libre

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in integration: only disposable accounts/profiles, a dedicated broker, localhost app/renderer.
func TestLiveDOM(t *testing.T) {
	if os.Getenv("LIBREBROWSER_DOM_LIVE_TEST") != "1" {
		t.Skip("requires DOM images and explicit Docker test opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	d := NewDocker("/var/run/docker.sock")
	name := "lb-dom-test-broker-" + Token()[:12]
	dir := t.TempDir()
	socket := filepath.Join(dir, "broker.sock")
	var gid = os.Getgid()
	spec := map[string]any{"Image": "librebrowser-dom-control:local", "Cmd": []string{"broker"}, "User": fmt.Sprintf("0:%d", gid),
		"Env":        []string{"BROWSER_ENGINE=dom", "DOM_CHROME_DIAGNOSTICS=1", "BROKER_CONTAINER=" + name, "SERVICE_IMAGE=librebrowser-dom-control:local", "DOM_ENGINE_IMAGE=librebrowser-dom-engine:local", "EGRESS_UPSTREAM_SOCKET=/run/librebrowser-uplink/proxy.sock", "EGRESS_UPSTREAM_VOLUME=librebrowser-v2raya-uplink"},
		"HostConfig": map[string]any{"Binds": []string{"/var/run/docker.sock:/var/run/docker.sock", dir + ":/run/librebrowser"}, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "ReadonlyRootfs": true, "Memory": 134217728, "PidsLimit": 64}}
	if err := d.call(ctx, "POST", "/containers/create?name="+name, spec, nil); err != nil {
		t.Fatal(err)
	}
	broker := &Broker{D: d, Engine: "dom", Self: name}
	var ids []string
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 2*time.Minute)
		defer done()
		for _, id := range ids {
			broker.Stop(cleanup, id, true)
			_, _, private, public := broker.names(id)
			d.call(cleanup, "POST", "/networks/"+private+"/disconnect", map[string]any{"Container": name, "Force": true}, nil)
			for _, network := range []string{private, public} {
				d.call(cleanup, "DELETE", "/networks/"+network, nil, nil)
			}
			d.call(cleanup, "DELETE", "/volumes/"+broker.domProfile(id), nil, nil)
		}
		d.call(cleanup, "POST", "/containers/"+name+"/stop?t=5", nil, nil)
		d.call(cleanup, "DELETE", "/containers/"+name+"?force=true", nil, nil)
	}()
	if err := d.call(ctx, "POST", "/containers/"+name+"/start", nil, nil); err != nil {
		t.Fatal(err)
	}
	backend := NewSocketBackend(socket)
	for n := 0; n < 100; n++ {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	a, admin, user := testApp(t)
	a.Backend = backend
	a.Config.Local = true
	a.Config.Engine = "dom"
	a.Config.Grace = 10 * time.Minute
	server := httptest.NewServer(a)
	defer server.Close()
	a.Config.Origin = server.URL
	renderer := httptest.NewServer(http.HandlerFunc(a.ServeRenderer))
	defer renderer.Close()
	a.Config.RendererOrigin = renderer.URL
	go a.RunMaintenance(ctx)
	ids = []string{admin.ID, user.ID}
	fixture := `<!doctype html><html><head><title>LibreBrowser DOM fixture</title></head><body>
<h1>Disposable DOM acceptance fixture</h1><p id="remote-marker"></p><input id="fixture-input"><p id="confirmed"></p>
<button id="save">Save profile marker</button><p id="persisted"></p><input type="file" id="upload"><p id="filename"></p>
<a id="download-file" href="data:text/plain;base64,TGlicmVCcm93c2VyIERPTSBkb3dubG9hZA==" download="dom-download.txt">Download fixture</a>
<div contenteditable="true" id="editor">Editable</div><div style="height:5000px">Scroll fixture</div>
<script>window.__serverScriptExecuted=true;document.querySelector('#remote-marker').textContent='executed on server';
const field=document.querySelector('#fixture-input');field.addEventListener('input',()=>{document.querySelector('#confirmed').textContent=field.value});
document.querySelector('#persisted').textContent=localStorage.getItem('librebrowser-fixture')||'empty';
document.querySelector('#save').onclick=()=>{localStorage.setItem('librebrowser-fixture',field.value);document.querySelector('#persisted').textContent=field.value};
document.querySelector('#upload').onchange=e=>document.querySelector('#filename').textContent=e.target.files[0]?.name||'';</script></body></html>`
	for _, id := range ids {
		if err := a.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
		engine, _, _, _ := broker.names(id)
		var ex struct {
			ID string `json:"Id"`
		}
		script := "require('node:fs').writeFileSync('/profile/chromium/librebrowser-fixture.html'," + fmt.Sprintf("%q", fixture) + ")"
		// Wait for the engine to create its Chromium profile before writing the synthetic fixture.
		ready := false
		for n := 0; n < 120; n++ {
			req, _ := http.NewRequestWithContext(ctx, "GET", "http://broker/users/"+id+"/render/healthz", nil)
			res, err := backend.Client.Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					ready = true
					break
				}
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !ready {
			t.Fatal("DOM engine not ready; inspect only the disposable engine's logs:", engine)
		}
		if err := d.call(ctx, "POST", "/containers/"+engine+"/exec", map[string]any{"Cmd": []string{"node", "-e", script}}, &ex); err != nil {
			t.Fatal(err)
		}
		if err := d.call(ctx, "POST", "/exec/"+ex.ID+"/start", map[string]bool{"Detach": false, "Tty": false}, nil); err != nil {
			t.Fatal(err)
		}
	}
    engine,_,_,_:=broker.names(ids[0])
    probe,probeErr:=exec.CommandContext(ctx,"docker","exec",engine,"node","--input-type=module","-e",`import {request,ProxyAgent} from 'undici';const r=await request('https://www.google.com/?hl=en',{dispatcher:new ProxyAgent(process.env.CHROME_PROXY_URL),headersTimeout:20000});console.log('Filtered Google HTTP:',r.statusCode);await r.body.dump();`).CombinedOutput()
    t.Log(string(probe));if probeErr!=nil{t.Log("filtered Google probe",probeErr)}
    root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll("/tmp/librebrowser-dom-verification", 0700)
	config, _ := json.Marshal(map[string]any{"origin": server.URL, "rendererOrigin": renderer.URL, "password": "long-test-password", "users": []map[string]string{{"username": admin.Username, "value": "alpha-profile-中文"}, {"username": user.Username, "value": "beta-profile-中文"}}})
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm", "-i", "--name", name+"-client", "--network", "host", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--security-opt", "seccomp="+filepath.Join(root, "internal/libre/chromium-seccomp.json"), "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=1777", "-e", "HOME=/tmp", "-v", "/tmp/librebrowser-dom-verification:/artifacts", "-v", filepath.Join(root, "scripts/dom-acceptance.mjs")+":/app/dom-acceptance.mjs:ro", "librebrowser-dom-engine:local", "node", "dom-acceptance.mjs")
	cmd.Stdin = strings.NewReader(string(config))
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		for _, id := range ids {
			engine, _, _, _ := broker.names(id)
			logs, _ := exec.Command("docker", "logs", "--tail", "80", engine).CombinedOutput()
			var state struct {
				State struct {
					Running, OOMKilled bool
					ExitCode           int
					Error              string
				}
			}
			d.call(ctx, "GET", "/containers/"+engine+"/json", nil, &state)
			t.Logf("engine lifecycle: %+v", state.State)
			os.WriteFile("/tmp/librebrowser-dom-verification/"+id+"-engine.log", logs, 0600)
			t.Log(string(logs))
		}
		t.Fatal("real DOM viewer acceptance", err)
	}
	for _, id := range ids {
		engine, egress, _, _ := broker.names(id)
		for _, resource := range []string{engine, egress} {
			if _, err := broker.inspect(ctx, resource, id); err == nil {
				t.Fatal("stopped container retained", resource)
			}
		}
		var volume any
		if err := d.call(ctx, "GET", "/volumes/"+broker.domProfile(id), nil, &volume); err != nil {
			t.Fatal("profile missing after stop", err)
		}
	}
	t.Log("Two isolated server Chromiums, local DOM/input, server-only website scripts, per-user persistent profile, stop/restart and released engine/egress containers passed.")
}

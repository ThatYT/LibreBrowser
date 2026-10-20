package libre

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Opt in only on the isolated Compose project. Creates two temporary browsers and removes their data.
func TestLiveChromium(t *testing.T) {
	if os.Getenv("LIBREBROWSER_LIVE_TEST") != "1" {
		t.Skip("requires explicit Docker acceptance-test opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	backend := NewSocketBackend(env("BROKER_SOCKET", "/run/librebrowser/broker.sock"))
	docker := NewDocker(env("DOCKER_SOCKET", "/var/run/docker.sock"))
	ids := []string{Token()[:32], Token()[:32]}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 2*time.Minute)
		defer done()
		for _, id := range ids {
			backend.Command(cleanup, id, "remove")
			_, _, private, public := names(id)
			docker.call(cleanup, "POST", "/networks/"+private+"/disconnect", map[string]any{"Container": "librebrowser-broker", "Force": true}, nil)
			for _, n := range []string{private, public} {
				docker.call(cleanup, "DELETE", "/networks/"+n, nil, nil)
			}
			docker.call(cleanup, "DELETE", "/volumes/lb-profile-"+id, nil, nil)
		}
	}()
	var wg sync.WaitGroup
	for _, id := range ids {
		for n := 0; n < 3; n++ {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				if e := backend.Command(ctx, id, "start"); e != nil {
					t.Error(e)
				}
			}(id)
		}
	}
	wg.Wait()
	if t.Failed() {
		return
	}
	wait := func(id string) {
		t.Helper()
		for n := 0; n < 120; n++ {
			r, _ := http.NewRequestWithContext(ctx, "GET", "http://broker/users/"+id+"/browser/", nil)
			res, e := backend.Client.Do(r)
			if e == nil {
				data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
				res.Body.Close()
				if res.StatusCode == 200 && strings.Contains(strings.ToLower(string(data)), "<html") {
					return
				}
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(time.Second):
			}
		}
		t.Fatal("Selkies frontend did not become ready")
	}
	for _, id := range ids {
		wait(id)
		name, _, _, _ := names(id)
		var c DockerInspect
		if e := docker.call(ctx, "GET", "/containers/"+name+"/json", nil, &c); e != nil {
			t.Fatal(e)
		}
		if len(c.HostConfig.PortBindings) != 0 || c.HostConfig.Privileged || c.HostConfig.RestartPolicy.Name != "no" {
			t.Fatal("unsafe browser host config")
		}
	}
	first, _, _, _ := names(ids[0])
	var before DockerInspect
	docker.call(ctx, "GET", "/containers/"+first+"/json", nil, &before)
	if e := backend.Command(ctx, ids[0], "stop"); e != nil {
		t.Fatal(e)
	}
	if e := backend.Command(ctx, ids[0], "start"); e != nil {
		t.Fatal(e)
	}
	wait(ids[0])
	var after DockerInspect
	docker.call(ctx, "GET", "/containers/"+first+"/json", nil, &after)
	if before.ID != after.ID {
		t.Fatal("existing container was replaced on reconnect")
	}
	t.Log("Two real Chromium frontends started without published ports; concurrent start and same-container reconnect passed. Complete interactive stream/profile/network checks in docs/DEPLOYMENT.md.")
}

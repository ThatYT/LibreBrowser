package libre

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func (b *Broker) startDOM(ctx context.Context, id, private, proxyIP string) error {
	name, _, _, _ := b.names(id)
	c, err := b.inspect(ctx, name, id)
	if err != nil {
		// Never adopt an existing foreign container, and never turn an inspect failure into a create.
		if !strings.Contains(err.Error(), ": 404 ") {
			return err
		}
		volume := b.domProfile(id)
		var existing struct{ Labels map[string]string }
		if e := b.D.call(ctx, "GET", "/volumes/"+volume, nil, &existing); e == nil {
			if existing.Labels[domOwnerLabel] != id || existing.Labels[brokerLabel] != b.Self {
				return ErrDenied
			}
		} else if !strings.Contains(e.Error(), ": 404 ") {
			return e
		}
		if err = b.D.call(ctx, "POST", "/volumes/create", map[string]any{"Name": volume, "Labels": b.labels(id)}, nil); err != nil {
			return err
		}
		spec := map[string]any{
			"Image": b.DOMImage, "User": "1000:1000", "Hostname": "lb-dom-" + id,
			"Labels": b.labels(id),
			"Env": []string{"LIBREBROWSER_USER_ID=" + id, "LIBREBROWSER_ENGINE_TOKEN=" + Token(), "CHROME_DIAGNOSTICS=" + env("DOM_CHROME_DIAGNOSTICS", "0"),
				"CHROME_PROXY_URL=http://" + net.JoinHostPort(proxyIP, "3128"), "HOME=/tmp", "MIRROR_E2E=0"},
			"HostConfig": map[string]any{
				"NetworkMode": private, "ReadonlyRootfs": true,
				"Mounts": []map[string]any{{"Type": "volume", "Source": volume, "Target": "/profile"}},
				"Tmpfs":  map[string]string{"/tmp": "rw,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=1777"},
				"Memory": b.Memory, "MemorySwap": b.Memory, "NanoCpus": b.CPU, "PidsLimit": b.Pids, "ShmSize": 536870912,
				"CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true", "seccomp=" + chromiumSeccomp},
				"RestartPolicy": map[string]string{"Name": "no"}, "Dns": []string{"127.0.0.1"},
			},
		}
		if err = b.D.call(ctx, "POST", "/containers/create?name="+name, spec, nil); err != nil {
			return err
		}
		c, err = b.inspect(ctx, name, id)
		if err != nil {
			return err
		}
	}
	if !c.State.Running {
		return b.D.call(ctx, "POST", "/containers/"+name+"/start", nil, nil)
	}
	return nil
}

func (b *Broker) proxyDOM(w http.ResponseWriter, r *http.Request, id, path string) {
	name, _, private, _ := b.names(id)
	c, err := b.inspect(r.Context(), name, id)
	if err != nil || !c.State.Running {
		http.Error(w, "browser stopped", 503)
		return
	}
	ip := c.NetworkSettings.Networks[private].IPAddress
	credential := ""
	for _, item := range c.Config.Env {
		if strings.HasPrefix(item, "LIBREBROWSER_ENGINE_TOKEN=") {
			credential = strings.TrimPrefix(item, "LIBREBROWSER_ENGINE_TOKEN=")
		}
	}
	if net.ParseIP(ip) == nil || len(credential) != 64 {
		http.Error(w, "engine unavailable", 503)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: net.JoinHostPort(ip, "3000")})
	r.URL.Path = "/" + path
	r.URL.RawPath = ""
	r.Header.Del("Cookie")
	r.Header.Del("Authorization")
	r.Header.Set("X-Libre-Engine-Token", credential)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "engine is starting or unavailable", 503)
	}
	proxy.ServeHTTP(w, r)
}

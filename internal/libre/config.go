package libre

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int64) int64 {
	v := env(k, strconv.FormatInt(d, 10))
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || n <= 0 {
		panic("invalid " + k)
	}
	return n
}

type Config struct {
	Prototype                              bool
	Listen, Origin, Database, BrokerSocket string
	Engine, RendererListen, RendererOrigin string
	Local                                  bool
	Trusted                                []*net.IPNet
	Grace                                  time.Duration
}

func LoadConfig() (Config, error) {
	c := Config{Listen: env("LISTEN_ADDR", "127.0.0.1:8090"), Origin: env("PUBLIC_ORIGIN", "http://localhost:8090"), Database: env("DATABASE_PATH", "data/librebrowser.db"), BrokerSocket: env("BROKER_SOCKET", "/run/librebrowser/broker.sock"), Local: env("LOCAL_DEV", "false") == "true", Grace: 10 * time.Minute, Engine: env("BROWSER_ENGINE", "stream"), RendererListen: env("RENDERER_LISTEN_ADDR", "127.0.0.1:8091"), RendererOrigin: env("RENDERER_ORIGIN", "")}
	idle, err := strconv.Atoi(env("BROWSER_IDLE_MINUTES", "10"))
	if err != nil || idle < 1 || idle > 1440 {
		return c, fmt.Errorf("BROWSER_IDLE_MINUTES must be 1–1440")
	}
	c.Grace = time.Duration(idle) * time.Minute
	c.Prototype = env("DOM_PROTOTYPE", "false") == "true"
	if c.Prototype && !c.Local {
		return c, fmt.Errorf("DOM_PROTOTYPE requires loopback local development")
	}
	if c.Engine != "stream" && c.Engine != "dom" {
		return c, fmt.Errorf("BROWSER_ENGINE must be stream or dom")
	}
	u, e := url.Parse(c.Origin)
	if e != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return c, fmt.Errorf("PUBLIC_ORIGIN must be an origin without a trailing slash")
	}
	if c.Local {
		host, _, e := net.SplitHostPort(c.Listen)
		if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			return c, fmt.Errorf("LOCAL_DEV requires a loopback listener")
		}
		if u.Scheme != "http" || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
			return c, fmt.Errorf("LOCAL_DEV origin must be loopback HTTP")
		}
	} else if u.Scheme != "https" {
		return c, fmt.Errorf("HTTPS origin required")
	}
	if c.Engine == "dom" {
		r, err := url.Parse(c.RendererOrigin)
		if err != nil || r.Host == "" || r.Path != "" || r.RawQuery != "" || r.Fragment != "" || r.User != nil || r.Scheme != u.Scheme || r.Host == u.Host {
			return c, fmt.Errorf("DOM mode requires a distinct RENDERER_ORIGIN with the same scheme")
		}
		if !c.Local && r.Hostname() == u.Hostname() {
			return c, fmt.Errorf("production renderer must use a different hostname from account/admin")
		}
		if c.Local {
			host, _, err := net.SplitHostPort(c.RendererListen)
			if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || (r.Hostname() != "localhost" && r.Hostname() != "127.0.0.1" && r.Hostname() != "::1") {
				return c, fmt.Errorf("local renderer must listen on loopback with a loopback origin")
			}
		}
	}
	for _, v := range strings.Split(env("TRUSTED_PROXY_CIDRS", "127.0.0.1/32,::1/128"), ",") {
		_, n, e := net.ParseCIDR(strings.TrimSpace(v))
		if e != nil {
			return c, e
		}
		c.Trusted = append(c.Trusted, n)
	}
	return c, nil
}

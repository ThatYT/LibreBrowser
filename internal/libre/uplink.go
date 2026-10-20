package libre

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// Upstreams receive only numeric addresses that Egress has already checked.
// Always tunnel, including HTTP, so the upstream cannot resolve a hostname
// again and bypass the destination policy. Never fall back to direct dialing.
func configureEgressUpstream(e *Egress, proxyURL, socket string) error {
	if proxyURL == "" && socket == "" {
		return nil
	}
	if proxyURL != "" && socket != "" {
		return errors.New("choose one egress upstream")
	}
	network, endpoint := "unix", socket
	if socket != "" && !filepath.IsAbs(socket) {
		return errors.New("egress upstream socket must be absolute")
	}
	if proxyURL != "" {
		u, err := url.Parse(proxyURL)
		if err != nil || u.Scheme != "http" || u.Hostname() == "" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("egress upstream must be an HTTP proxy URL with an explicit port and no credentials or path")
		}
		if _, _, err := net.SplitHostPort(u.Host); err != nil {
			return errors.New("invalid upstream address")
		}
		network, endpoint = "tcp", u.Host
	}
	e.Dial = func(ctx context.Context, _, target string) (net.Conn, error) {
		c, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, endpoint)
		if err != nil {
			return nil, err
		}
		success := false
		defer func() {
			if !success {
				c.Close()
			}
		}()
		deadline := time.Now().Add(15 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		if err = c.SetDeadline(deadline); err != nil {
			return nil, err
		}
		cancelHandshake := context.AfterFunc(ctx, func() { c.Close() })
		defer cancelHandshake()
		req := &http.Request{Method: "CONNECT", URL: &url.URL{Opaque: target}, Host: target, Header: make(http.Header)}
		if err = req.Write(c); err != nil {
			return nil, err
		}
		reader := bufio.NewReader(c)
		res, err := http.ReadResponse(reader, req)
		if err != nil {
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("egress upstream refused tunnel: %d", res.StatusCode)
		}
		if !cancelHandshake() {
			return nil, ctx.Err()
		}
		if err = c.SetDeadline(time.Time{}); err != nil {
			return nil, err
		}
		success = true
		return &bufferedTunnel{Conn: c, reader: reader}, nil
	}
	return nil
}

type bufferedTunnel struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedTunnel) Read(p []byte) (int, error) { return c.reader.Read(p) }

func listenEgressSocket(path string) (net.Listener, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("egress listener socket must be absolute")
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("egress listener path is not a socket")
		}
		c, dialErr := net.DialTimeout("unix", path, time.Second)
		if dialErr == nil {
			c.Close()
			return nil, errors.New("egress listener already running")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

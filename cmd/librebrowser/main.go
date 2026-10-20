package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ThatYT/LibreBrowser/internal/libre"
	"golang.org/x/term"
)

func main() {
	if e := run(); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Print(e)
		os.Exit(1)
	}
}
func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		c, e := libre.LoadConfig()
		if e != nil {
			return e
		}
		return libre.ServeApp(ctx, c)
	case "broker-health":
		path := os.Getenv("BROKER_SOCKET")
		if path == "" {
			path = "/run/librebrowser/broker.sock"
		}
		c, e := net.DialTimeout("unix", path, 2*time.Second)
		if e != nil {
			return e
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(2 * time.Second))
		fmt.Fprint(c, "GET /healthz HTTP/1.1\r\nHost: broker\r\nConnection: close\r\n\r\n")
		res, e := http.ReadResponse(bufio.NewReader(c), nil)
		if e != nil {
			return e
		}
		defer res.Body.Close()
		if res.StatusCode != 204 {
			return errors.New("broker not healthy")
		}
		return nil
	case "broker":
		return libre.ServeBroker(ctx)
	case "egress":
		return libre.ServeEgress(ctx)
	case "admin":
		return admin(os.Args[2:])
	default:
		return fmt.Errorf("usage: librebrowser [serve|broker|egress|admin init|admin reset-password]")
	}
}
func admin(args []string) error {
	if len(args) == 0 || (args[0] != "init" && args[0] != "reset-password") {
		return errors.New("usage: librebrowser admin {init|reset-password} --username thatyt")
	}
	flags := flag.NewFlagSet("admin", flag.ContinueOnError)
	username := flags.String("username", "thatyt", "LibreBrowser username (independent of Linux)")
	if e := flags.Parse(args[1:]); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	// A local terminal and access to the private database are the recovery trust boundary.
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return errors.New("administrator recovery requires an interactive local terminal")
	}
	fmt.Fprint(os.Stderr, "New LibreBrowser password: ")
	first, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if e != nil {
		return e
	}
	defer clear(first)
	fmt.Fprint(os.Stderr, "Repeat password: ")
	second, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if e != nil {
		return e
	}
	defer clear(second)
	if string(first) != string(second) {
		return errors.New("passwords do not match")
	}
	path := os.Getenv("DATABASE_PATH")
	if path == "" {
		path = "data/librebrowser.db"
	}
	store, e := libre.OpenStore(path)
	if e != nil {
		return e
	}
	defer store.DB.Close()
	if args[0] == "init" {
		_, e = store.Create(*username, string(first), "ADMIN", true)
	} else {
		e = store.Reset(*username, string(first))
	}
	if e == nil {
		fmt.Fprintln(os.Stderr, "LibreBrowser account updated. Linux accounts were not changed.")
	}
	return e
}

package libre

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, e := OpenStore(filepath.Join(t.TempDir(), "accounts.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.DB.Close() })
	return s
}
func mustUser(t *testing.T, s *Store, name, role string, bootstrap bool) User {
	t.Helper()
	u, e := s.Create(name, "long-test-password", role, bootstrap)
	if e != nil {
		t.Fatal(e)
	}
	return u
}
func TestPasswordHash(t *testing.T) {
	h, e := HashPassword("correct-horse-battery")
	if e != nil {
		t.Fatal(e)
	}
	if !VerifyPassword(h, "correct-horse-battery") || VerifyPassword(h, "wrong") {
		t.Fatal("password verification")
	}
	for _, v := range []string{"", "$argon2id$v=19$m=1,t=1,p=1$a$b", h + "$"} {
		if VerifyPassword(v, "correct-horse-battery") {
			t.Fatal("accepted malformed hash")
		}
	}
	if _, e = HashPassword("short"); e == nil {
		t.Fatal("weak password accepted")
	}
}
func TestBootstrapAndLastAdmin(t *testing.T) {
	s := testStore(t)
	u := mustUser(t, s, "thatyt", "ADMIN", true)
	if _, e := s.Create("second", "long-test-password", "ADMIN", true); e == nil {
		t.Fatal("bootstrap twice")
	}
	for _, a := range []struct{ action, value string }{{"delete", ""}, {"role", "USER"}, {"disabled", "true"}} {
		if e := s.Mutate(u.ID, a.action, a.value); e == nil {
			t.Fatal("last admin removed", a)
		}
	}
	other := mustUser(t, s, "other", "ADMIN", false)
	if e := s.Mutate(u.ID, "role", "USER"); e != nil {
		t.Fatal(e)
	}
	if e := s.Mutate(other.ID, "disabled", "true"); e == nil {
		t.Fatal("last enabled admin disabled")
	}
}
func TestSessionsResetDisableDelete(t *testing.T) {
	s := testStore(t)
	mustUser(t, s, "thatyt", "ADMIN", true)
	u := mustUser(t, s, "reader", "USER", false)
	u, e := s.Authenticate("reader", "long-test-password")
	if e != nil {
		t.Fatal(e)
	}
	token, _, e := s.NewSession(u)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Session(token); e != nil {
		t.Fatal(e)
	}
	if e = s.Reset("reader", "replacement-password"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Session(token); e == nil {
		t.Fatal("reset did not revoke")
	}
	if _, _, e = s.NewSession(u); e == nil {
		t.Fatal("stale authentication issued session after reset")
	}
	u, e = s.Authenticate("reader", "replacement-password")
	if e != nil {
		t.Fatal(e)
	}
	token, _, _ = s.NewSession(u)
	s.Mutate(u.ID, "disabled", "true")
	if _, e = s.Session(token); e == nil {
		t.Fatal("disabled session active")
	}
	if _, e = s.Authenticate("reader", "replacement-password"); e == nil {
		t.Fatal("disabled login")
	}
	if e = s.Mutate(u.ID, "delete", ""); e != nil {
		t.Fatal(e)
	}
	users, _ := s.Users()
	if len(users) != 1 {
		t.Fatal(users)
	}
}
func TestSessionExpiryAndPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.db")
	s, e := OpenStore(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	u := mustUser(t, s, "thatyt", "ADMIN", true)
	token, _, _ := s.NewSession(u)
	s.DB.Exec("UPDATE sessions SET expires=?", time.Now().Add(-time.Second).Unix())
	if _, e = s.Session(token); e == nil {
		t.Fatal("expired accepted")
	}
	stat, _ := os.Stat(path)
	if stat.Mode().Perm() != 0600 {
		t.Fatal("database permissions", stat.Mode())
	}
}

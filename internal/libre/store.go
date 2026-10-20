package libre

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

var ErrDenied = errors.New("operation denied")
var usernameRE = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

type User struct {
	generation int64
	ID         string `json:"id"`
	Username   string `json:"username"`
	Role       string `json:"role"`
	Disabled   bool   `json:"disabled"`
}
type Identity struct {
	User
	TokenHash string
	CSRF      string
	Expires   int64
}
type Store struct {
	DB    *sql.DB
	dummy string
}

func Token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func HashPassword(password string) (string, error) {
	if len(password) < 12 || len(password) > 1024 {
		return "", errors.New("password must contain 12–1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
func VerifyPassword(encoded, password string) bool {
	if len(password) > 1024 {
		return false
	}
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[1] != "argon2id" || p[2] != "v=19" || p[3] != "m=65536,t=3,p=2" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p[4])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(p[5])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err := os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('USER','ADMIN')),disabled INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id); PRAGMA user_version=1;`)
	if err != nil {
		db.Close()
		return nil, err
	}
	dummy, err := HashPassword(Token())
	return &Store{db, dummy}, err
}
func (s *Store) Create(username, password, role string, bootstrap bool) (User, error) {
	u := User{ID: Token()[:32], Username: username, Role: role}
	if !usernameRE.MatchString(username) || (role != "USER" && role != "ADMIN") {
		return u, ErrDenied
	}
	hash, err := HashPassword(password)
	if err != nil {
		return u, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return u, err
	}
	defer tx.Rollback()
	if bootstrap {
		var n int
		if err = tx.QueryRow("SELECT count(*) FROM users").Scan(&n); err != nil {
			return u, err
		}
		if n != 0 || role != "ADMIN" {
			return u, ErrDenied
		}
	}
	_, err = tx.Exec("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)", u.ID, username, hash, role)
	if err != nil {
		return u, err
	}
	return u, tx.Commit()
}
func (s *Store) Authenticate(username, password string) (User, error) {
	var u User
	var hash string
	err := s.DB.QueryRow("SELECT id,username,password,role,disabled,generation FROM users WHERE username=?", username).Scan(&u.ID, &u.Username, &hash, &u.Role, &u.Disabled, &u.generation)
	if err != nil {
		VerifyPassword(s.dummy, password)
		return u, ErrDenied
	}
	if !VerifyPassword(hash, password) || u.Disabled {
		return u, ErrDenied
	}
	return u, nil
}
func (s *Store) NewSession(u User) (string, string, error) {
	token, csrf := Token(), Token()
	tx, err := s.DB.Begin()
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	// Only issue while the account still has the same credential generation: caller serializes account mutations.
	_, err = tx.Exec("DELETE FROM sessions WHERE expires<=?", time.Now().Unix())
	if err == nil {
		var result sql.Result
		result, err = tx.Exec("INSERT INTO sessions SELECT ?,id,?,? FROM users WHERE id=? AND disabled=0 AND generation=?", digest(token), csrf, time.Now().Add(24*time.Hour).Unix(), u.ID, u.generation)
		if err == nil {
			n, _ := result.RowsAffected()
			if n != 1 {
				return "", "", ErrDenied
			}
		}
	}
	if err != nil {
		return "", "", err
	}
	return token, csrf, tx.Commit()
}
func (s *Store) Session(token string) (Identity, error) {
	var i Identity
	if len(token) != 64 {
		return i, ErrDenied
	}
	return s.SessionHash(digest(token))
}

// SessionHash validates a renderer grant against its original revocable login session.
func (s *Store) SessionHash(hash string) (Identity, error) {
	var i Identity
	if len(hash) != 64 {
		return i, ErrDenied
	}
	err := s.DB.QueryRow(`SELECT u.id,u.username,u.role,u.disabled,s.csrf,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0`, hash, time.Now().Unix()).Scan(&i.ID, &i.Username, &i.Role, &i.Disabled, &i.CSRF, &i.Expires)
	i.TokenHash = hash
	return i, err
}
func (s *Store) Revoke(hash string) error {
	_, e := s.DB.Exec("DELETE FROM sessions WHERE token=?", hash)
	return e
}
func (s *Store) Users() ([]User, error) {
	rows, e := s.DB.Query("SELECT id,username,role,disabled FROM users ORDER BY username")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Disabled); e != nil {
			return nil, e
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
func (s *Store) Mutate(id, action, value string) error {
	tx, e := s.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var role string
	var disabled bool
	if e = tx.QueryRow("SELECT role,disabled FROM users WHERE id=?", id).Scan(&role, &disabled); e != nil {
		return e
	}
	if role == "ADMIN" && !disabled && (action == "delete" || (action == "role" && value != "ADMIN") || (action == "disabled" && value == "true")) {
		var n int
		if e = tx.QueryRow("SELECT count(*) FROM users WHERE role='ADMIN' AND disabled=0").Scan(&n); e != nil {
			return e
		}
		if n <= 1 {
			return errors.New("cannot remove the last enabled administrator")
		}
	}
	switch action {
	case "delete":
		_, e = tx.Exec("DELETE FROM users WHERE id=?", id)
	case "role":
		if value != "USER" && value != "ADMIN" {
			return ErrDenied
		}
		_, e = tx.Exec("UPDATE users SET role=?,generation=generation+1 WHERE id=?", value, id)
	case "disabled":
		if value != "true" && value != "false" {
			return ErrDenied
		}
		_, e = tx.Exec("UPDATE users SET disabled=?,generation=generation+1 WHERE id=?", value == "true", id)
	case "password":
		var h string
		h, e = HashPassword(value)
		if e == nil {
			_, e = tx.Exec("UPDATE users SET password=?,generation=generation+1 WHERE id=?", h, id)
		}
	default:
		return ErrDenied
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM sessions WHERE user_id=?", id); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) Reset(username, password string) error {
	var id string
	if e := s.DB.QueryRow("SELECT id FROM users WHERE username=?", username).Scan(&id); e != nil {
		return e
	}
	return s.Mutate(id, "password", password)
}

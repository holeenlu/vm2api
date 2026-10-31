package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPAndHTTPSAuthenticatedTunnel(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run(map[bool]string{false: "http", true: "https"}[secure], func(t *testing.T) {
			seen := make(chan string, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "CONNECT" || r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("user:p@ss")) {
					w.WriteHeader(407)
					return
				}
				seen <- r.Host
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer conn.Close()
				_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\nready")
				_, _ = io.Copy(conn, conn)
			})
			s := httptest.NewUnstartedServer(handler)
			if secure {
				s.StartTLS()
			} else {
				s.Start()
			}
			defer s.Close()
			d, err := New(strings.Replace(s.URL, "://", "://user:p%40ss@", 1), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if secure {
				if conn, err := d.DialContext(context.Background(), "tcp", "remote.invalid:443"); err == nil {
					conn.Close()
					t.Fatal("untrusted proxy certificate accepted")
				}
				roots := x509.NewCertPool()
				roots.AddCert(s.Certificate())
				d.TLSConfig = &tls.Config{RootCAs: roots}
			}
			conn, err := d.DialContext(context.Background(), "tcp", "remote.invalid:443")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			data := make([]byte, 5)
			if _, err = io.ReadFull(conn, data); err != nil || string(data) != "ready" {
				t.Fatalf("buffered CONNECT bytes lost: %s %v", data, err)
			}
			payload := strings.Repeat("echo", 20000)
			go func() { _, _ = io.WriteString(conn, payload) }()
			body := make([]byte, len(payload))
			if _, err = io.ReadFull(conn, body); err != nil || string(body) != payload {
				t.Fatalf("tunnel: %v", err)
			}
			if target := <-seen; target != "remote.invalid:443" {
				t.Fatalf("target = %s", target)
			}
		})
	}
}

func TestConnectRejectsAuthenticationAndUnsupportedProtocols(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(407) }))
	defer s.Close()
	d, err := New(s.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.DialContext(context.Background(), "tcp", "remote.invalid:443"); err == nil || !strings.Contains(err.Error(), "407") {
		t.Fatalf("expected proxy auth error: %v", err)
	}
	for _, raw := range []string{"ftp://localhost:21", "https://localhost:443/path", "http://localhost:80?secret=x"} {
		if _, err := New(raw, time.Second); err == nil {
			t.Fatalf("accepted unsupported proxy: %s", raw)
		}
	}
}

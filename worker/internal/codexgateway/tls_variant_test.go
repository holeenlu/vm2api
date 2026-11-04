package codexgateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	utls "github.com/refraction-networking/utls"
)

// 同一出口的第二次握手复用 TLS 1.3 会话（pre_shared_key），native-tls 与 rustls 指纹都适用。
func TestUpstreamTLSResumesSessions(t *testing.T) {
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	upstream.TLS = &tls.Config{MinVersion: tls.VersionTLS13}
	upstream.StartTLS()
	defer upstream.Close()
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	addr := strings.TrimPrefix(upstream.URL, "https://")
	for _, profile := range []helloProfile{helloNativeTLS, helloRustls} {
		out, err := newUpstreamEgress("")
		if err != nil {
			t.Fatal(err)
		}
		resumed := []bool{}
		for i := 0; i < 2; i++ {
			conn, err := out.dialTLS(context.Background(), "127.0.0.1:"+strings.Split(addr, ":")[1], roots, profile)
			if err != nil {
				t.Fatalf("profile %d dial %d: %v", profile, i, err)
			}
			// TLS 1.3 的会话票据在握手后下发，发一个请求让客户端读到它
			_, _ = io.WriteString(conn, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
			_, _ = io.ReadAll(conn)
			resumed = append(resumed, conn.(*utls.UConn).ConnectionState().DidResume)
			_ = conn.Close()
		}
		if resumed[0] || !resumed[1] {
			t.Fatalf("profile %d resumption=%v, want [false true]", profile, resumed)
		}
	}
}

// 配置 CODEX_CA_CERTIFICATE 后 HTTPS 以 rustls 指纹声明 h2 并走 HTTP/2；无效文件启动失败。
func TestCustomCASwitchesHTTPToRustlsH2(t *testing.T) {
	var proto int
	var alpn []string
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proto = r.ProtoMajor
		_, _ = io.WriteString(w, "ok")
	}))
	upstream.EnableHTTP2 = true
	upstream.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		alpn = hello.SupportedProtos
		return nil, nil
	}}
	upstream.StartTLS()
	defer upstream.Close()
	dir := t.TempDir()
	caFile := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(codexCACertEnv, caFile)
	server, _, _ := newExecuteServer(t, upstream.URL)
	if !server.customCA {
		t.Fatal("custom CA not loaded")
	}
	client, err := server.clientFor(Account{})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Get(upstream.URL + "/x")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if proto != 2 || strings.Join(alpn, ",") != "h2,http/1.1" {
		t.Fatalf("proto=%d alpn=%v", proto, alpn)
	}

	if err := os.WriteFile(caFile, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstream.URL}
	cfg.applyDefaults()
	if _, err := NewServer(cfg); err == nil || !strings.Contains(err.Error(), "CODEX_CA_CERTIFICATE") {
		t.Fatalf("invalid CA file must fail startup: %v", err)
	}
}

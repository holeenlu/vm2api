package codexgateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
)

// 自定义 CA（对齐 codex-proxy-rs transport/tls.rs）：CODEX_CA_CERTIFICATE 优先，其次 SSL_CERT_FILE；
// 证书追加到系统根证书。文件不可读或没有可用证书时启动失败，避免静默退回系统根证书。
const (
	codexCACertEnv = "CODEX_CA_CERTIFICATE"
	sslCertFileEnv = "SSL_CERT_FILE"
	caCertHint     = "If you set CODEX_CA_CERTIFICATE or SSL_CERT_FILE, ensure it points to a PEM file containing one or more CERTIFICATE blocks, or unset it to use system roots."
)

func configuredCABundle() (string, string) {
	for _, name := range []string{codexCACertEnv, sslCertFileEnv} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return name, value
		}
	}
	return "", ""
}

// loadCustomCA 返回系统根证书加自定义 CA；未配置时返回 nil。
func loadCustomCA() (*x509.CertPool, error) {
	source, path := configuredCABundle()
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read CA certificate file %s selected by %s: %w. %s", path, source, err, caCertHint)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	count := 0
	for index := 1; ; {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" && block.Type != "TRUSTED CERTIFICATE" {
			continue
		}
		der := block.Bytes
		if block.Type == "TRUSTED CERTIFICATE" {
			// OpenSSL 的 TRUSTED CERTIFICATE 在证书后附加信任设置，只取第一个 DER 对象
			var raw asn1.RawValue
			if _, err := asn1.Unmarshal(der, &raw); err != nil {
				return nil, fmt.Errorf("failed to parse certificate #%d from %s selected by %s: %w. %s", index, path, source, err, caCertHint)
			}
			der = raw.FullBytes
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, fmt.Errorf("failed to parse certificate #%d from %s selected by %s: %w. %s", index, path, source, err, caCertHint)
		}
		pool.AddCert(cert)
		count++
		index++
	}
	if count == 0 {
		return nil, fmt.Errorf("failed to load CA certificates from %s selected by %s: no certificates found. %s", path, source, caCertHint)
	}
	return pool, nil
}

// h2Variant：HTTPS 经 rustls 指纹（ALPN h2,http/1.1）走 HTTP/2；明文目标（本地上游、测试）仍用 HTTP/1.1。
type h2Variant struct {
	h1 *http.Transport
	h2 *http2.Transport
}

var errALPNNotH2 = errors.New("upstream did not negotiate HTTP/2")

func newH2Variant(out *upstreamEgress, roots *x509.CertPool, h1 *http.Transport) *h2Variant {
	return &h2Variant{h1: h1, h2: &http2.Transport{
		DialTLSContext: func(ctx context.Context, _, addr string, _ *tls.Config) (net.Conn, error) {
			conn, err := out.dialTLS(ctx, addr, roots, helloRustlsH2)
			if err != nil {
				return nil, err
			}
			if state, ok := conn.(*utls.UConn); ok && state.ConnectionState().NegotiatedProtocol != "h2" {
				_ = conn.Close()
				return nil, errALPNNotH2
			}
			return conn, nil
		},
		ReadIdleTimeout: 30 * time.Second,
		PingTimeout:     15 * time.Second,
	}}
}

func (v *h2Variant) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		return v.h1.RoundTrip(req)
	}
	return v.h2.RoundTrip(req)
}

func (v *h2Variant) CloseIdleConnections() {
	v.h1.CloseIdleConnections()
	v.h2.CloseIdleConnections()
}

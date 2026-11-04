package codexgateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"time"

	egress "github.com/dofastted/kin-gateway/worker/internal/proxy"
	utls "github.com/refraction-networking/utls"
)

// 上游 TLS 指纹对齐 codex-proxy-rs（官方 Codex 823ea830c0 采样，见 CPR tests/transport/tls.rs）：
// HTTP 默认路径是 native-tls（OpenSSL）握手，扩展顺序固定、无 ALPN（HTTP/1.1）；
// WebSocket 是 rustls 握手，扩展顺序每次随机、无 ALPN。两者都把 X25519MLKEM768 + X25519 作为 key share。
type helloProfile int

const (
	helloNativeTLS helloProfile = iota
	helloRustls
	// helloRustlsH2：配置自定义 CA（CODEX_CA_CERTIFICATE / SSL_CERT_FILE）时官方 HTTP 改用 rustls，
	// 声明 ALPN h2,http/1.1 并走 HTTP/2
	helloRustlsH2
)

const upstreamTLSHandshakeTimeout = 15 * time.Second

// nativeTLSHelloSpec：OpenSSL 默认套件与扩展 [65281,0,11,10,35,22,23,13,43,45,51]。
// DHE 套件、X448/FFDHE 组与 DSA/SHA224 签名算法只用于对齐声明；TLS 1.3 下不会被选中。
func nativeTLSHelloSpec() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin:         tls.VersionTLS12,
		TLSVersMax:         tls.VersionTLS13,
		CompressionMethods: []byte{0},
		CipherSuites: []uint16{
			4866, 4867, 4865, 49196, 49200, 159, 52393, 52392, 52394, 49195, 49199, 158, 49188,
			49192, 107, 49187, 49191, 103, 49162, 49172, 57, 49161, 49171, 51, 157, 156, 61, 60, 53, 47,
		},
		Extensions: []utls.TLSExtension{
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SNIExtension{},
			&utls.SupportedPointsExtension{SupportedPoints: []byte{0}},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, 30, utls.CurveP384, utls.CurveP521, 256, 257}},
			&utls.SessionTicketExtension{},
			&utls.GenericExtension{Id: 22}, // encrypt_then_mac
			&utls.ExtendedMasterSecretExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: signatureSchemes(
				2309, 2310, 2308, 1027, 1283, 1539, 2055, 2056, 2074, 2075, 2076, 2057, 2058, 2059,
				2052, 2053, 2054, 1025, 1281, 1537, 771, 769, 770, 1026, 1282, 1538,
			)},
			&utls.SupportedVersionsExtension{Versions: []uint16{tls.VersionTLS13, tls.VersionTLS12}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}},
			// 复用会话时追加 pre_shared_key（必须是最后一个扩展）；无可复用会话时省略
			&utls.UtlsPreSharedKeyExtension{},
		},
	}
}

// rustlsHelloSpec：rustls 0.23（aws-lc-rs、prefer-post-quantum）默认集合，扩展顺序与 rustls 一样逐连接随机。
// renegotiation 用 SCSV（255）声明而非扩展。
func rustlsHelloSpec(alpn ...string) *utls.ClientHelloSpec {
	extensions := []utls.TLSExtension{
		&utls.SNIExtension{},
		&utls.StatusRequestExtension{},
		&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384}},
		&utls.SupportedPointsExtension{SupportedPoints: []byte{0}},
		&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: signatureSchemes(
			1283, 1027, 1539, 2055, 2054, 2053, 2052, 1537, 1281, 1025, 2308, 2309, 2310,
		)},
		&utls.ExtendedMasterSecretExtension{},
		&utls.SessionTicketExtension{},
		&utls.SupportedVersionsExtension{Versions: []uint16{tls.VersionTLS13, tls.VersionTLS12}},
		&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
		&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}},
	}
	if len(alpn) > 0 {
		extensions = append(extensions, &utls.ALPNExtension{AlpnProtocols: alpn})
	}
	rand.Shuffle(len(extensions), func(i, j int) { extensions[i], extensions[j] = extensions[j], extensions[i] })
	// rustls 恢复会话时 pre_shared_key 固定在最后
	extensions = append(extensions, &utls.UtlsPreSharedKeyExtension{})
	return &utls.ClientHelloSpec{
		TLSVersMin:         tls.VersionTLS12,
		TLSVersMax:         tls.VersionTLS13,
		CompressionMethods: []byte{0},
		CipherSuites:       []uint16{4866, 4865, 4867, 49196, 49195, 52393, 49200, 49199, 52392, utls.FAKE_TLS_EMPTY_RENEGOTIATION_INFO_SCSV},
		Extensions:         extensions,
	}
}

func signatureSchemes(values ...uint16) []utls.SignatureScheme {
	out := make([]utls.SignatureScheme, len(values))
	for i, value := range values {
		out[i] = utls.SignatureScheme(value)
	}
	return out
}

// upstreamTLS 在已建立的 TCP/隧道连接上完成指纹握手；每个连接使用新的 spec（utls 会改写扩展内部状态）。
func upstreamTLS(ctx context.Context, raw net.Conn, serverName string, roots *x509.CertPool, profile helloProfile, sessions utls.ClientSessionCache) (net.Conn, error) {
	spec := nativeTLSHelloSpec()
	switch profile {
	case helloRustls:
		spec = rustlsHelloSpec()
	case helloRustlsH2:
		spec = rustlsHelloSpec("h2", "http/1.1")
	}
	conn := utls.UClient(raw, &utls.Config{ServerName: serverName, RootCAs: roots, MinVersion: tls.VersionTLS12, ClientSessionCache: sessions, OmitEmptyPsk: true}, utls.HelloCustom)
	if err := conn.ApplyPreset(spec); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("apply TLS fingerprint: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, upstreamTLSHandshakeTimeout)
	defer cancel()
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

// upstreamEgress 是账号的出站路径：直连，或经 SOCKS5 隧道（指定代理不可用时不回退直连）。
// 目标一律先建隧道；TLS 目标再由本进程完成指纹握手。
type upstreamEgress struct {
	tunnelDialer *egress.Dialer
	// sessions 是本出口按指纹分开的 TLS 会话缓存（官方 native-tls 与 rustls 都会复用会话）；
	// 按出口隔离，避免不同代理 IP 之间通过会话票据关联
	sessions [3]utls.ClientSessionCache
}

const tlsSessionCacheSize = 64

func newUpstreamEgress(proxyURL string) (*upstreamEgress, error) {
	proxyURL = strings.TrimSpace(proxyURL)
	out := &upstreamEgress{}
	for i := range out.sessions {
		out.sessions[i] = utls.NewLRUClientSessionCache(tlsSessionCacheSize)
	}
	if proxyURL == "" {
		return out, nil
	}
	dialer, err := egress.New(proxyURL, 15*time.Second)
	if err != nil {
		return nil, err
	}
	out.tunnelDialer = dialer
	return out, nil
}

// tunnel 建立到 addr 的字节流（直连或代理隧道）。
func (e *upstreamEgress) tunnel(ctx context.Context, addr string) (net.Conn, error) {
	if e.tunnelDialer != nil {
		return e.tunnelDialer.DialContext(ctx, "tcp", addr)
	}
	conn, err := (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	egress.ApplyTCPKeepAlive(conn)
	return conn, nil
}

// dialTLS 建隧道并按 profile 完成指纹握手。
func (e *upstreamEgress) dialTLS(ctx context.Context, addr string, roots *x509.CertPool, profile helloProfile) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	raw, err := e.tunnel(ctx, addr)
	if err != nil {
		return nil, err
	}
	return upstreamTLS(ctx, raw, host, roots, profile, e.sessions[profile])
}

// newUpstreamTransport：HTTPS 走 native-tls 指纹的 HTTP/1.1（官方 HTTP 默认路径不声明 ALPN）；
// 配置自定义 CA 时改走 rustls + HTTP/2（与官方 reqwest 换用 rustls 一致）。不继承环境代理。
func (s *Server) newUpstreamTransport(proxyURL string) (http.RoundTripper, error) {
	out, err := newUpstreamEgress(proxyURL)
	if err != nil {
		return nil, err
	}
	h1, err := s.newHTTP1Transport(out)
	if err != nil || !s.customCA {
		return h1, err
	}
	return newH2Variant(out, s.upstreamRoots, h1), nil
}

func (s *Server) newHTTP1Transport(out *upstreamEgress) (*http.Transport, error) {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return out.tunnel(ctx, addr)
		},
		DialTLSContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			return out.dialTLS(ctx, addr, s.upstreamRoots, helloNativeTLS)
		},
		ForceAttemptHTTP2:     false,
		TLSNextProto:          map[string]func(string, *tls.Conn) http.RoundTripper{},
		MaxIdleConns:          256,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return transport, nil
}

var errWSDeflateWindow = errors.New("upstream requires a smaller client deflate window")

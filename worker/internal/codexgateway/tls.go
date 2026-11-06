package codexgateway

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

// mTLS 身份约定（中期技术债 M2，与控制面 src/lib/gateway-worker/gateway-mtls.mjs 相同）：
//   - Worker 证书：SAN URI urn:kin:gateway:<实例 ID>（也认 spiffe://vm2api/gateway-worker/<实例 ID>），没有这两种 URI 时看 CN；
//   - 控制面证书：DNS 名或 IP 与 KIN_CODEX_GATEWAY_CONTROL_PLANE_SERVER_NAME 一致（未设置时取回连地址的主机名），
//     或 SAN URI 等于该值 / urn:kin:control-plane:<该值>；带 Worker 身份的证书不能充当控制面。
// scripts/gateway-mtls-certs.sh 按这个约定生成测试证书链。

const (
	workerIdentityURN    = "urn:kin:gateway:"
	workerIdentitySPIFFE = "spiffe://vm2api/gateway-worker/"
	controlPlaneURN      = "urn:kin:control-plane"
)

func (s *Server) serverTLSConfig() (*tls.Config, error) {
	if !s.cfg.RequireMTLS {
		return nil, nil
	}
	cert, err := tls.LoadX509KeyPair(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load gateway TLS certificate: %w", err)
	}
	caData, err := os.ReadFile(s.cfg.TLSCAFile)
	if err != nil {
		return nil, fmt.Errorf("read gateway TLS CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caData) {
		return nil, errors.New("gateway TLS CA does not contain a certificate")
	}
	clientSAN := strings.TrimSpace(s.cfg.TLSClientSAN)
	// 未配置 CONTROL_PLANE_SERVER_NAME 时按回连地址推出的名称要求对方是控制面（审查 P2）
	controlName := s.controlPlaneExpectedName()
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ServerName:   s.cfg.TLSServerName,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("gateway client certificate missing")
			}
			peer := state.PeerCertificates[0]
			if !peer.NotBefore.Before(time.Now()) || !peer.NotAfter.After(time.Now()) {
				return errors.New("gateway client certificate expired")
			}
			// 只有控制面能调用 Worker 的内部接口：另一个 Worker 的证书（URI 身份）即使由同一 CA 签发也拒绝；
			// 只有 CN 身份的 Worker 证书由下面的“必须是控制面”拦下
			if len(workerIdentities(peer)) > 0 || len(commonNames(peer)) > 1 {
				return errors.New("gateway client certificate belongs to a gateway worker")
			}
			if clientSAN != "" {
				if !certificateMatchesInstance(peer, clientSAN) {
					return fmt.Errorf("gateway client certificate SAN does not match %s", clientSAN)
				}
			} else if controlName != "" && !controlPlaneIdentityMatches(peer, controlName) {
				return fmt.Errorf("gateway client certificate is not the control plane %s", controlName)
			}
			return nil
		},
	}, nil
}

// certificateMatchesInstance：KIN_CODEX_GATEWAY_TLS_CLIENT_SAN 的既有约定（DNS 名、gateway-worker/<值> 或 spiffe URI）
func certificateMatchesInstance(cert *x509.Certificate, instanceID string) bool {
	for _, name := range cert.DNSNames {
		if name == instanceID || name == "gateway-worker/"+instanceID {
			return true
		}
	}
	for _, uri := range cert.URIs {
		if uri.String() == "spiffe://vm2api/gateway-worker/"+instanceID || uri.Path == "/gateway-worker/"+instanceID {
			return true
		}
	}
	return false
}

// workerIdentities 是证书 SAN URI 里的 Worker 实例 ID。URN 的 scheme 与 NID、spiffe 的 scheme 与信任域不区分大小写，
// 实例 ID 区分大小写（与控制面 gateway-mtls.mjs 一致）。
func workerIdentities(cert *x509.Certificate) []string {
	var ids []string
	for _, uri := range cert.URIs {
		value := uri.String()
		for _, prefix := range []string{workerIdentityURN, workerIdentitySPIFFE} {
			if len(value) > len(prefix) && strings.EqualFold(value[:len(prefix)], prefix) {
				ids = append(ids, value[len(prefix):])
				break
			}
		}
	}
	return ids
}

// commonNames：主体里的全部 CN（多个 CN 的证书不绑定任何身份）
func commonNames(cert *x509.Certificate) []string {
	var names []string
	for _, attr := range cert.Subject.Names {
		if attr.Type.Equal([]int{2, 5, 4, 3}) {
			if value, ok := attr.Value.(string); ok {
				names = append(names, value)
			}
		}
	}
	return names
}

// certificateBoundToInstance：证书是否代表该实例（多个 CN 时不代表任何实例；有实例 URI 时必须全部等于它，否则看 CN）。
func certificateBoundToInstance(cert *x509.Certificate, instanceID string) bool {
	if len(commonNames(cert)) > 1 {
		return false
	}
	if ids := workerIdentities(cert); len(ids) > 0 {
		for _, id := range ids {
			if id != instanceID {
				return false
			}
		}
		return true
	}
	return instanceID != "" && cert.Subject.CommonName == instanceID
}

// controlPlaneIdentityMatches：控制面证书与预期名称一致（DNS/IP 主机名校验，或 SAN URI）；带 Worker 身份的证书不算。
func controlPlaneIdentityMatches(cert *x509.Certificate, expected string) bool {
	if expected == "" || len(workerIdentities(cert)) > 0 || len(commonNames(cert)) > 1 {
		return false
	}
	for _, uri := range cert.URIs {
		value := uri.String()
		if value == expected || value == controlPlaneURN+":"+expected {
			return true
		}
	}
	return cert.VerifyHostname(expected) == nil
}

// controlPlaneExpectedName：Worker 期望的控制面证书名称；未配置时取回连地址的主机名。
func (s *Server) controlPlaneExpectedName() string {
	if name := strings.TrimSpace(s.cfg.ControlPlaneServerName); name != "" {
		return name
	}
	for _, raw := range []string{s.cfg.ControlPlaneURL, s.cfg.ReceiptURL} {
		if parsed, err := url.Parse(strings.TrimSpace(raw)); err == nil && parsed.Hostname() != "" {
			return parsed.Hostname()
		}
	}
	return ""
}

// verifyControlPlaneCertificate 校验控制面服务端证书链（roots 为空时用系统根证书）与身份。
func verifyControlPlaneCertificate(chain []*x509.Certificate, roots *x509.CertPool, expected string, now time.Time) error {
	if len(chain) == 0 {
		return errors.New("control plane certificate missing")
	}
	intermediates := x509.NewCertPool()
	for _, cert := range chain[1:] {
		intermediates.AddCert(cert)
	}
	leaf := chain[0]
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return fmt.Errorf("control plane certificate: %w", err)
	}
	if expected == "" {
		return errors.New("control plane certificate name is not configured")
	}
	if !controlPlaneIdentityMatches(leaf, expected) {
		return fmt.Errorf("control plane certificate does not match %s", expected)
	}
	return nil
}

func (s *Server) controlTLSConfig() (*tls.Config, error) {
	if strings.TrimSpace(s.cfg.TLSClientCertFile) == "" || strings.TrimSpace(s.cfg.TLSClientKeyFile) == "" {
		return nil, nil
	}
	cert, err := tls.LoadX509KeyPair(s.cfg.TLSClientCertFile, s.cfg.TLSClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load gateway client certificate: %w", err)
	}
	var pool *x509.CertPool
	if strings.TrimSpace(s.cfg.TLSCAFile) != "" {
		data, err := os.ReadFile(s.cfg.TLSCAFile)
		if err != nil {
			return nil, err
		}
		pool = x509.NewCertPool()
		if !pool.AppendCertsFromPEM(data) {
			return nil, errors.New("gateway TLS CA does not contain a certificate")
		}
	}
	expected := s.controlPlaneExpectedName()
	config := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, RootCAs: pool}
	if expected != "" && !strings.Contains(expected, ":") || net.ParseIP(expected) != nil {
		config.ServerName = expected
	}
	// 标准校验只比对 ServerName；这里改为自定义校验：链仍按 RootCAs 校验，身份另认 SAN URI，并拒绝带 Worker 身份的证书
	config.InsecureSkipVerify = true
	config.VerifyConnection = func(state tls.ConnectionState) error {
		return verifyControlPlaneCertificate(state.PeerCertificates, pool, expected, time.Now())
	}
	return config, nil
}

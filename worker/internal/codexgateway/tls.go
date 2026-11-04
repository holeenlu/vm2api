package codexgateway

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
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
			if clientSAN != "" && !certificateMatchesInstance(peer, clientSAN) {
				return fmt.Errorf("gateway client certificate SAN does not match %s", clientSAN)
			}
			return nil
		},
	}, nil
}

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

func (s *Server) controlTLSConfig() (*tls.Config, error) {
	if strings.TrimSpace(s.cfg.TLSClientCertFile) == "" || strings.TrimSpace(s.cfg.TLSClientKeyFile) == "" {
		return nil, nil
	}
	cert, err := tls.LoadX509KeyPair(s.cfg.TLSClientCertFile, s.cfg.TLSClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load gateway client certificate: %w", err)
	}
	config := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ServerName: s.cfg.TLSServerName}
	if strings.TrimSpace(s.cfg.TLSCAFile) != "" {
		data, err := os.ReadFile(s.cfg.TLSCAFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(data) {
			return nil, errors.New("gateway TLS CA does not contain a certificate")
		}
		config.RootCAs = pool
	}
	return config, nil
}

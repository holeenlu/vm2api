package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Dialer always tunnels through the selected proxy. A failed tunnel never falls back to direct.
type Dialer struct {
	Address  string
	Username string
	Password string
	Timeout  time.Duration
	Scheme   string
	// Optional extra trust roots for controlled deployments/tests. Verification stays enabled.
	TLSConfig *tls.Config
}

func New(rawURL string, timeout time.Duration) (*Dialer, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, errors.New("invalid proxy URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "socks5" && scheme != "socks5h" && scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("unsupported proxy scheme %q", scheme)
	}
	port := u.Port()
	if port == "" {
		switch scheme {
		case "http":
			port = "80"
		case "https":
			port = "443"
		default:
			port = "1080"
		}
	}
	p, err := strconv.Atoi(port)
	if u.Hostname() == "" || err != nil || p < 1 || p > 65535 || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid proxy host, port or URL path")
	}
	username, password := "", ""
	if u.User != nil {
		username = u.User.Username()
		password, _ = u.User.Password()
	}
	if strings.HasPrefix(scheme, "socks") && (len(username) > 255 || len(password) > 255) {
		return nil, errors.New("SOCKS5 username/password exceeds 255 bytes")
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Dialer{Address: net.JoinHostPort(u.Hostname(), port), Username: username, Password: password, Timeout: timeout, Scheme: scheme}, nil
}

func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if d == nil {
		return nil, errors.New("proxy dialer is nil")
	}
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("proxy only supports TCP, got %q", network)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.ContainsAny(host, "\r\n") {
		return nil, errors.New("invalid tunnel target")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return nil, errors.New("invalid tunnel target port")
	}
	if sameHostPort(address, d.Address) {
		return nil, errors.New("refusing proxy CONNECT to the proxy address")
	}
	ctx, cancel := context.WithTimeout(ctx, d.Timeout)
	defer cancel()
	base := &net.Dialer{Timeout: d.Timeout}
	conn, err := base.DialContext(ctx, "tcp", d.Address)
	if err != nil {
		return nil, fmt.Errorf("connect proxy: %w", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	stopCancel := make(chan struct{})
	rawConn := conn
	go func() {
		select {
		case <-ctx.Done():
			_ = rawConn.SetDeadline(time.Now())
		case <-stopCancel:
		}
	}()
	defer close(stopCancel)
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	if d.Scheme == "https" {
		proxyHost, _, _ := net.SplitHostPort(d.Address)
		config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: proxyHost}
		if d.TLSConfig != nil {
			config = d.TLSConfig.Clone()
			config.ServerName = proxyHost
			config.InsecureSkipVerify = false
		}
		tlsConn := tls.Client(conn, config)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return nil, fmt.Errorf("proxy TLS: %w", err)
		}
		conn = tlsConn
	}
	if d.Scheme == "http" || d.Scheme == "https" {
		conn, err = d.connectHTTP(conn, address)
	} else {
		if d.Scheme == "socks5" && net.ParseIP(host) == nil {
			ips, resolveErr := net.DefaultResolver.LookupIPAddr(ctx, host)
			if resolveErr != nil || len(ips) == 0 {
				return nil, fmt.Errorf("resolve SOCKS5 target: %w", resolveErr)
			}
			address = net.JoinHostPort(ips[0].IP.String(), port)
		}
		err = d.negotiate(conn, address)
	}
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	ApplyTCPKeepAlive(rawConn)
	ok = true
	return conn, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (d *Dialer) connectHTTP(conn net.Conn, address string) (net.Conn, error) {
	req := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: address}, Host: address, Header: make(http.Header)}
	if d.Username != "" || d.Password != "" {
		req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(d.Username+":"+d.Password)))
	}
	if err := req.Write(conn); err != nil {
		return conn, fmt.Errorf("write proxy CONNECT: %w", err)
	}
	limited := &io.LimitedReader{R: conn, N: 64 * 1024}
	reader := bufio.NewReaderSize(limited, 4096)
	res, err := http.ReadResponse(reader, req)
	if err != nil {
		return conn, fmt.Errorf("read proxy CONNECT: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return conn, fmt.Errorf("proxy CONNECT returned HTTP %d", res.StatusCode)
	}
	limited.N = math.MaxInt64
	// Bytes already buffered after the CONNECT response belong to the tunnel.
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

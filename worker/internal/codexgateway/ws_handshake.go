package codexgateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

// 官方 Codex（tungstenite）opening handshake 的线级顺序（CPR tests/transport/websocket/fingerprint.rs）：
// Host、Connection、Upgrade、Sec-WebSocket-Version、Sec-WebSocket-Key 用固定大小写在前，
// 业务头小写按下表，最后是 sec-websocket-extensions。表外的头保持在业务头之后、扩展声明之前（按名称排序）。
var wsOfficialHeaderOrder = []string{
	"chatgpt-account-id",
	"authorization",
	"user-agent",
	"originator",
	"openai-beta",
	"version",
	"x-codex-beta-features",
	"x-client-request-id",
	"session-id",
	"thread-id",
	"x-codex-window-id",
	"x-codex-turn-metadata",
	"x-codex-routing-hint",
}

const wsExtensionOffer = "permessage-deflate; client_max_window_bits"

// wsHandshakeTransport 自行写出 WebSocket opening：net/http 按字母序写头，也无法声明 client_max_window_bits，
// 不能复现官方顺序。TLS 用 rustls 指纹且不声明 ALPN（WebSocket 升级只走 HTTP/1.1）。
type wsHandshakeTransport struct {
	server *Server
	egress *upstreamEgress
}

func (t *wsHandshakeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	addr := req.URL.Host
	if req.URL.Port() == "" {
		port := "80"
		if req.URL.Scheme == "https" {
			port = "443"
		}
		addr = net.JoinHostPort(req.URL.Hostname(), port)
	}
	target := req.URL.RequestURI()
	var conn net.Conn
	var err error
	proxyAuth := ""
	switch {
	case req.URL.Scheme == "https":
		conn, err = t.egress.dialTLS(ctx, addr, t.server.upstreamRoots, helloRustls)
	case t.egress.forward != nil && t.egress.forward.Scheme == "http":
		// 明文目标经 HTTP 代理：absolute-form 请求交给代理转发
		conn, err = t.egress.tunnelDialerConn(ctx)
		target = req.URL.String()
		if user := t.egress.forward.User; user != nil {
			password, _ := user.Password()
			proxyAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user.Username()+":"+password))
		}
	default:
		conn, err = t.egress.tunnel(ctx, addr)
	}
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	opening, err := wsOpening(req, host, target, proxyAuth)
	if err == nil {
		_, err = conn.Write(opening)
	}
	var resp *http.Response
	reader := bufio.NewReader(conn)
	if err == nil {
		resp, err = http.ReadResponse(reader, req)
	}
	if !stop() || err != nil {
		_ = conn.Close()
		if err == nil {
			err = ctx.Err()
		}
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		resp.Body = closeWith{ReadCloser: resp.Body, conn: conn}
		return resp, nil
	}
	if err := normalizeWSExtensionResponse(resp.Header); err != nil {
		_ = conn.Close()
		return nil, err
	}
	resp.Body = &wsStream{reader: reader, Conn: conn}
	return resp, nil
}

// tunnelDialerConn 连到 HTTP 代理本身（absolute-form 转发用）。
func (e *upstreamEgress) tunnelDialerConn(ctx context.Context) (net.Conn, error) {
	return (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", e.tunnelDialer.Address)
}

func wsOpening(req *http.Request, host, target, proxyAuth string) ([]byte, error) {
	var out bytes.Buffer
	write := func(name, value string) error {
		if strings.ContainsAny(name, "\r\n:") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("invalid WebSocket opening header %q", name)
		}
		out.WriteString(name)
		out.WriteString(": ")
		out.WriteString(value)
		out.WriteString("\r\n")
		return nil
	}
	fmt.Fprintf(&out, "GET %s HTTP/1.1\r\n", target)
	for _, pair := range [][2]string{
		{"Host", host},
		{"Connection", "Upgrade"},
		{"Upgrade", "websocket"},
		{"Sec-WebSocket-Version", "13"},
		{"Sec-WebSocket-Key", req.Header.Get("Sec-WebSocket-Key")},
	} {
		if err := write(pair[0], pair[1]); err != nil {
			return nil, err
		}
	}
	if proxyAuth != "" {
		if err := write("Proxy-Authorization", proxyAuth); err != nil {
			return nil, err
		}
	}
	rank := make(map[string]int, len(wsOfficialHeaderOrder))
	for i, name := range wsOfficialHeaderOrder {
		rank[name] = i
	}
	names := make([]string, 0, len(req.Header))
	for key := range req.Header {
		lower := strings.ToLower(key)
		switch lower {
		case "host", "connection", "upgrade", "sec-websocket-version", "sec-websocket-key", "sec-websocket-extensions", "proxy-authorization":
			continue
		}
		names = append(names, key)
	}
	sort.SliceStable(names, func(i, j int) bool {
		a, b := strings.ToLower(names[i]), strings.ToLower(names[j])
		ra, okA := rank[a]
		rb, okB := rank[b]
		switch {
		case okA && okB:
			return ra < rb
		case okA != okB:
			return okA
		}
		return a < b
	})
	for _, key := range names {
		for _, value := range req.Header[key] {
			if err := write(strings.ToLower(key), value); err != nil {
				return nil, err
			}
		}
	}
	if req.Header.Get("Sec-WebSocket-Extensions") != "" {
		if err := write("sec-websocket-extensions", wsExtensionOffer); err != nil {
			return nil, err
		}
	}
	out.WriteString("\r\n")
	return out.Bytes(), nil
}

// normalizeWSExtensionResponse：服务端对 client_max_window_bits 的回应只能是 15（或不带值），
// 本端 deflate 固定 32 KiB 窗口；去掉该参数后交给 websocket 库校验其余参数。
func normalizeWSExtensionResponse(header http.Header) error {
	values := header.Values("Sec-WebSocket-Extensions")
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		var params []string
		for _, part := range strings.Split(value, ";") {
			part = strings.TrimSpace(part)
			name, arg, hasArg := strings.Cut(part, "=")
			if strings.TrimSpace(name) == "client_max_window_bits" {
				if hasArg && strings.Trim(strings.TrimSpace(arg), `"`) != "15" {
					return errWSDeflateWindow
				}
				continue
			}
			params = append(params, part)
		}
		out = append(out, strings.Join(params, "; "))
	}
	header.Del("Sec-WebSocket-Extensions")
	for _, value := range out {
		header.Add("Sec-WebSocket-Extensions", value)
	}
	return nil
}

// wsStream 是升级后的双向字节流：读取先消费握手响应后已缓冲的字节；
// 写方向把 websocket 库的分片压缩消息（数据帧 + 空 FIN 续帧）合并为官方 tungstenite 的单帧（FIN+RSV1）。
type wsStream struct {
	reader *bufio.Reader
	net.Conn
	pending   []byte
	message   []byte
	first     byte
	inMessage bool
}

func (s *wsStream) Read(p []byte) (int, error) { return s.reader.Read(p) }

func (s *wsStream) Write(p []byte) (int, error) {
	s.pending = append(s.pending, p...)
	consumed := 0
	for {
		frame, size, ok := parseClientFrame(s.pending[consumed:])
		if !ok {
			break
		}
		consumed += size
		if err := s.forward(frame); err != nil {
			return 0, err
		}
	}
	s.pending = append(s.pending[:0], s.pending[consumed:]...)
	return len(p), nil
}

type clientFrame struct {
	fin     bool
	flags   byte // RSV 位与 opcode
	payload []byte
}

func (s *wsStream) forward(frame clientFrame) error {
	opcode := frame.flags & 0x0f
	switch {
	case opcode >= 0x8:
		return writeClientFrame(s.Conn, 0x80|frame.flags, frame.payload)
	case opcode != 0 && frame.fin:
		return writeClientFrame(s.Conn, 0x80|frame.flags, frame.payload)
	case opcode != 0:
		s.first, s.inMessage = frame.flags, true
		s.message = append(s.message[:0], frame.payload...)
		return nil
	case !s.inMessage:
		return errors.New("websocket continuation frame without a message")
	}
	s.message = append(s.message, frame.payload...)
	if !frame.fin {
		return nil
	}
	s.inMessage = false
	return writeClientFrame(s.Conn, 0x80|s.first, s.message)
}

// parseClientFrame 解析一个完整的客户端（已掩码）帧并返回解掩码后的负载；数据不足时 ok=false。
func parseClientFrame(b []byte) (clientFrame, int, bool) {
	if len(b) < 2 {
		return clientFrame{}, 0, false
	}
	offset := 2
	length := uint64(b[1] & 0x7f)
	switch length {
	case 126:
		if len(b) < 4 {
			return clientFrame{}, 0, false
		}
		length, offset = uint64(binary.BigEndian.Uint16(b[2:])), 4
	case 127:
		if len(b) < 10 {
			return clientFrame{}, 0, false
		}
		length, offset = binary.BigEndian.Uint64(b[2:]), 10
	}
	var mask []byte
	if b[1]&0x80 != 0 {
		if len(b) < offset+4 {
			return clientFrame{}, 0, false
		}
		mask, offset = b[offset:offset+4], offset+4
	}
	if uint64(len(b)-offset) < length {
		return clientFrame{}, 0, false
	}
	end := offset + int(length)
	payload := append([]byte(nil), b[offset:end]...)
	for i := range payload {
		if mask != nil {
			payload[i] ^= mask[i%4]
		}
	}
	return clientFrame{fin: b[0]&0x80 != 0, flags: b[0] & 0x7f, payload: payload}, end, true
}

func writeClientFrame(w io.Writer, first byte, payload []byte) error {
	header := []byte{first, 0}
	switch n := len(payload); {
	case n < 126:
		header[1] = byte(n)
	case n <= 0xffff:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(n))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}
	header[1] |= 0x80
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	out := make([]byte, 0, len(header)+4+len(payload))
	out = append(append(out, header...), mask[:]...)
	for i, c := range payload {
		out = append(out, c^mask[i%4])
	}
	_, err := w.Write(out)
	return err
}

type closeWith struct {
	io.ReadCloser
	conn net.Conn
}

func (c closeWith) Close() error {
	err := c.ReadCloser.Close()
	_ = c.conn.Close()
	return err
}

package codexgateway

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// clientHello 对应 CPR tests/transport/tls.rs 的采样字段。
type clientHello struct {
	LegacyVersion     uint16
	SupportedVersions []uint16
	PointFormats      []byte
	PSKModes          []byte
	CipherSuites      []uint16
	Extensions        []uint16
	Groups            []uint16
	SignatureSchemes  []uint16
	KeyShares         [][2]int
	ALPN              []string
}

func officialHTTPHello() clientHello {
	return clientHello{
		LegacyVersion:     771,
		SupportedVersions: []uint16{772, 771},
		PointFormats:      []byte{0},
		PSKModes:          []byte{1},
		CipherSuites: []uint16{4866, 4867, 4865, 49196, 49200, 159, 52393, 52392, 52394, 49195, 49199, 158, 49188,
			49192, 107, 49187, 49191, 103, 49162, 49172, 57, 49161, 49171, 51, 157, 156, 61, 60, 53, 47},
		Extensions: []uint16{65281, 0, 11, 10, 35, 22, 23, 13, 43, 45, 51},
		Groups:     []uint16{4588, 29, 23, 30, 24, 25, 256, 257},
		SignatureSchemes: []uint16{2309, 2310, 2308, 1027, 1283, 1539, 2055, 2056, 2074, 2075, 2076, 2057, 2058, 2059,
			2052, 2053, 2054, 1025, 1281, 1537, 771, 769, 770, 1026, 1282, 1538},
		KeyShares: [][2]int{{4588, 1216}, {29, 32}},
	}
}

func officialWebSocketHello() clientHello {
	return clientHello{
		LegacyVersion:     771,
		SupportedVersions: []uint16{772, 771},
		PointFormats:      []byte{0},
		PSKModes:          []byte{1},
		CipherSuites:      []uint16{4866, 4865, 4867, 49196, 49195, 52393, 49200, 49199, 52392, 255},
		Extensions:        []uint16{0, 5, 10, 11, 13, 23, 35, 43, 45, 51},
		Groups:            []uint16{4588, 29, 23, 24},
		SignatureSchemes:  []uint16{1283, 1027, 1539, 2055, 2054, 2053, 2052, 1537, 1281, 1025, 2308, 2309, 2310},
		KeyShares:         [][2]int{{4588, 1216}, {29, 32}},
	}
}

// captureClientHello 接受一个连接，读出 ClientHello 后回 alert 终止握手。
func captureClientHello(t *testing.T, listener net.Listener) <-chan clientHello {
	t.Helper()
	out := make(chan clientHello, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		// 经 SOCKS5 代理时先完成无认证握手和 CONNECT，之后才是 ClientHello
		if peek, _ := reader.Peek(1); len(peek) == 1 && peek[0] == 5 {
			if !acceptSOCKS5(reader, conn) {
				return
			}
		}
		header := make([]byte, 5)
		if _, err := io.ReadFull(reader, header); err != nil || header[0] != 22 {
			return
		}
		record := make([]byte, binary.BigEndian.Uint16(header[3:]))
		if _, err := io.ReadFull(reader, record); err != nil {
			return
		}
		_, _ = conn.Write([]byte{21, 3, 3, 0, 2, 2, 40})
		out <- parseClientHello(record)
	}()
	return out
}

// acceptSOCKS5 扮演最小的无认证 SOCKS5 代理：只回应握手与 CONNECT，不转发任何数据。
func acceptSOCKS5(reader *bufio.Reader, conn net.Conn) bool {
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(reader, greeting); err != nil || greeting[0] != 5 {
		return false
	}
	if _, err := io.ReadFull(reader, make([]byte, greeting[1])); err != nil {
		return false
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		return false
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(reader, head); err != nil || head[0] != 5 || head[1] != 1 {
		return false
	}
	var addr int
	switch head[3] {
	case 1:
		addr = 4
	case 4:
		addr = 16
	case 3:
		length, err := reader.ReadByte()
		if err != nil {
			return false
		}
		addr = int(length)
	default:
		return false
	}
	if _, err := io.ReadFull(reader, make([]byte, addr+2)); err != nil {
		return false
	}
	_, err := conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	return err == nil
}

func parseClientHello(b []byte) clientHello {
	take := func(n int) []byte { v := b[:n]; b = b[n:]; return v }
	u16 := func(v []byte) uint16 { return binary.BigEndian.Uint16(v) }
	vector := func(src *[]byte) []byte {
		n := int(u16((*src)[:2]))
		v := (*src)[2 : 2+n]
		*src = (*src)[2+n:]
		return v
	}
	u16s := func(v []byte) []uint16 {
		out := []uint16{}
		for i := 0; i+1 < len(v); i += 2 {
			out = append(out, u16(v[i:]))
		}
		return out
	}
	var hello clientHello
	take(4)
	hello.LegacyVersion = u16(take(2))
	take(32)
	take(int(take(1)[0]))
	hello.CipherSuites = u16s(vector(&b))
	take(int(take(1)[0]))
	exts := vector(&b)
	values := map[uint16][]byte{}
	for len(exts) > 0 {
		kind := u16(exts[:2])
		exts = exts[2:]
		hello.Extensions = append(hello.Extensions, kind)
		values[kind] = vector(&exts)
	}
	groups := values[10]
	hello.Groups = u16s(vector(&groups))
	sigs := values[13]
	hello.SignatureSchemes = u16s(vector(&sigs))
	shares := values[51]
	shares = vector(&shares)
	for len(shares) > 0 {
		group := u16(shares[:2])
		shares = shares[2:]
		hello.KeyShares = append(hello.KeyShares, [2]int{int(group), len(vector(&shares))})
	}
	if protocols, ok := values[16]; ok {
		list := vector(&protocols)
		for len(list) > 0 {
			n := int(list[0])
			hello.ALPN = append(hello.ALPN, string(list[1:1+n]))
			list = list[1+n:]
		}
	}
	hello.SupportedVersions = u16s(values[43][1:])
	hello.PointFormats = values[11][1:]
	hello.PSKModes = values[45][1:]
	return hello
}

func listenLocal(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func localhostURL(scheme string, listener net.Listener) string {
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	return scheme + "://localhost:" + port + "/backend-api/codex"
}

func TestUpstreamHTTPClientHelloMatchesOfficialNativeTLS(t *testing.T) {
	server, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
	for _, viaProxy := range []bool{false, true} {
		listener := listenLocal(t)
		hello := captureClientHello(t, listener)
		account := Account{}
		target := localhostURL("https", listener)
		if viaProxy {
			// 同一监听器先扮演 SOCKS5 代理；隧道目标随意，ClientHello 仍须是指纹 spec
			account.ProxyURL = "socks5h://" + listener.Addr().String()
			target = "https://chatgpt.invalid/backend-api/codex"
		}
		client, err := server.clientFor(account)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			if resp, err := client.Get(target); err == nil {
				resp.Body.Close()
			}
		}()
		select {
		case got := <-hello:
			want := officialHTTPHello()
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("viaProxy=%v ClientHello mismatch\n got=%+v\nwant=%+v", viaProxy, got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("viaProxy=%v: no ClientHello captured", viaProxy)
		}
	}
}

func TestUpstreamWebSocketClientHelloMatchesOfficialRustls(t *testing.T) {
	server, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
	orders := map[string]bool{}
	for i := 0; i < 4; i++ {
		listener := listenLocal(t)
		server.cfg.UpstreamBaseURL = localhostURL("https", listener)
		hello := captureClientHello(t, listener)
		go func() {
			if conn, _, err := server.dialWS(context.Background(), Account{AccessToken: "token"}, nil, "", nil, attemptState{}); err == nil {
				conn.CloseNow()
			}
		}()
		select {
		case got := <-hello:
			orders[fmt.Sprint(got.Extensions)] = true
			slices.Sort(got.Extensions)
			if want := officialWebSocketHello(); !reflect.DeepEqual(got, want) {
				t.Fatalf("ClientHello mismatch\n got=%+v\nwant=%+v", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no ClientHello captured")
		}
	}
	if len(orders) < 2 {
		t.Fatalf("rustls extension order should be randomized per connection, got %v", orders)
	}
}

// 指纹 spec 必须能与真实 TLS 1.3 服务端完成握手（含 X25519MLKEM768），HTTP 与 WebSocket 都走得通。
func TestUpstreamFingerprintHandshakesCompleteOverTLS(t *testing.T) {
	fake := &fakeWSUpstream{}
	upstream := httptest.NewTLSServer(fake.handler(t))
	t.Cleanup(upstream.Close)
	server, _, _ := newExecuteServer(t, upstream.URL)
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	server.upstreamRoots = roots
	server.cfg.UpstreamBaseURL = strings.Replace(upstream.URL, "127.0.0.1", "localhost", 1) + "/backend-api/codex"
	// httptest 证书覆盖 example.com 与 127.0.0.1；通过 localhost 访问需要证书包含该名称
	if err := upstream.Certificate().VerifyHostname("localhost"); err != nil {
		server.cfg.UpstreamBaseURL = upstream.URL + "/backend-api/codex"
	}
	client, err := server.clientFor(Account{})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Post(server.cfg.UpstreamBaseURL+"/responses", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.ProtoMajor != 1 || !strings.Contains(string(body), "resp_http") {
		t.Fatalf("HTTP over fingerprint TLS: status=%d proto=%s body=%s", resp.StatusCode, resp.Proto, body)
	}
	conn, _, err := server.dialWS(context.Background(), Account{AccessToken: "token"}, nil, "model=gpt-5.5", nil, attemptState{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"response.create","model":"gpt-5.5"}`)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, data, err := conn.Read(ctx); err != nil || !strings.Contains(string(data), "response.created") {
		t.Fatalf("WebSocket over fingerprint TLS: %s %v", data, err)
	}
}

// 官方 opening 的线级头顺序、扩展声明与首帧压缩（CPR fingerprint.rs）。
func TestUpstreamWebSocketOpeningMatchesOfficialWireOrder(t *testing.T) {
	listener := listenLocal(t)
	type captured struct {
		opening    string
		firstByte  byte
		frameError error
	}
	result := make(chan captured, 1)
	var accepted atomic.Bool
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)
		var opening strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				result <- captured{frameError: err}
				return
			}
			opening.WriteString(line)
			if line == "\r\n" {
				break
			}
		}
		key := ""
		for _, line := range strings.Split(opening.String(), "\r\n") {
			if name, value, ok := strings.Cut(line, ": "); ok && strings.EqualFold(name, "sec-websocket-key") {
				key = value
			}
		}
		sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: "+
			base64.StdEncoding.EncodeToString(sum[:])+"\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits=15\r\n\r\n")
		accepted.Store(true)
		first, err := reader.ReadByte()
		result <- captured{opening: opening.String(), firstByte: first, frameError: err}
	}()
	server, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
	server.cfg.UpstreamBaseURL = "http://" + listener.Addr().String() + "/backend-api/codex"
	inbound := map[string]string{
		"x-codex-turn-metadata": `{"kind":"fingerprint"}`,
		"x-codex-beta-features": "feature-a",
		"x-codex-window-id":     "window-fingerprint",
		"session-id":            "session-fingerprint",
		"thread-id":             "thread-fingerprint",
		"x-client-request-id":   "request-fingerprint",
		"traceparent":           "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	}
	conn, _, err := server.dialWS(context.Background(), Account{AccessToken: "access-token", ChatGPTAccountID: "account-fingerprint", InstallationID: "install-fingerprint"}, inbound, "model=gpt-5.5", nil, attemptState{})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"response.create","model":"gpt-5.5","instructions":"be brief","input":[],"tools":[],"tool_choice":"auto","parallel_tool_calls":true}`)); err != nil {
		t.Fatal(err)
	}
	got := <-result
	if got.frameError != nil {
		t.Fatal(got.frameError)
	}
	lines := strings.Split(strings.TrimSuffix(got.opening, "\r\n\r\n"), "\r\n")
	if lines[0] != "GET /backend-api/codex/responses HTTP/1.1" {
		t.Fatalf("request line=%q", lines[0])
	}
	var names []string
	values := map[string]string{}
	for _, line := range lines[1:] {
		name, value, _ := strings.Cut(line, ": ")
		names = append(names, name)
		values[strings.ToLower(name)] = value
	}
	wantNames := []string{"Host", "Connection", "Upgrade", "Sec-WebSocket-Version", "Sec-WebSocket-Key",
		"chatgpt-account-id", "authorization", "user-agent", "originator", "openai-beta", "version",
		"x-codex-beta-features", "x-client-request-id", "session-id", "thread-id", "x-codex-window-id",
		"x-codex-turn-metadata", "x-codex-routing-hint",
		// 官方顺序表外的头（本账号安装头、透传的 trace）按名称排在业务头之后（CPR websocket_header_order）
		"traceparent", "x-codex-installation-id", "sec-websocket-extensions"}
	if !reflect.DeepEqual(names, wantNames) {
		t.Fatalf("opening header order\n got=%v\nwant=%v", names, wantNames)
	}
	if values["sec-websocket-extensions"] != "permessage-deflate; client_max_window_bits" ||
		values["openai-beta"] != wsBetaHeader || values["x-codex-routing-hint"] != "model=gpt-5.5" ||
		values["authorization"] != "Bearer access-token" || values["x-codex-installation-id"] != "install-fingerprint" {
		t.Fatalf("opening values=%v", values)
	}
	if got.firstByte != 0b1100_0001 {
		t.Fatalf("first frame byte=%08b, want FIN+RSV1+text", got.firstByte)
	}
}

func TestNormalizeWSExtensionResponseRejectsSmallerClientWindow(t *testing.T) {
	header := http.Header{"Sec-Websocket-Extensions": {"permessage-deflate; client_max_window_bits=10"}}
	if err := normalizeWSExtensionResponse(header); err != errWSDeflateWindow {
		t.Fatalf("err=%v", err)
	}
	header = http.Header{"Sec-Websocket-Extensions": {"permessage-deflate; client_max_window_bits=15; server_no_context_takeover"}}
	if err := normalizeWSExtensionResponse(header); err != nil || header.Get("Sec-WebSocket-Extensions") != "permessage-deflate; server_no_context_takeover" {
		t.Fatalf("header=%v err=%v", header, err)
	}
}

func TestCodexRoutingHint(t *testing.T) {
	for body, want := range map[string]string{
		`{"model":"gpt-5.5"}`:                           "model=gpt-5.5",
		`{"model":"gpt-5.5","service_tier":"priority"}`: "model=gpt-5.5;tier=priority",
		`{"input":[]}`:                                  "",
	} {
		if got := codexRoutingHint([]byte(body)); got != want {
			t.Fatalf("%s: got %q want %q", body, got, want)
		}
	}
}

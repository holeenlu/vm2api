package codexgateway

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newExecuteServer(t *testing.T, upstreamURL string, accounts ...Account) (*Server, *httptest.Server, Config) {
	t.Helper()
	// HTTP 路径的用例固定上游 HTTP/SSE；上游 WebSocket 在 ws_test.go 单独覆盖
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstreamURL, UpstreamTransport: "http", RequestTimeoutSec: 5}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range accounts {
		if _, err := server.store.Upsert(account); err != nil {
			t.Fatal(err)
		}
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, httpServer, cfg
}

func signedExecute(t *testing.T, cfg Config, baseURL string, envelope Envelope) *http.Response {
	t.Helper()
	if envelope.Version == 0 {
		envelope.Version = 1
	}
	if envelope.ExpiresAt.IsZero() {
		envelope.ExpiresAt = time.Now().Add(time.Minute)
	}
	body, _ := json.Marshal(envelope)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce := "http_" + envelope.Nonce
	req, _ := http.NewRequest(http.MethodPost, baseURL+"/internal/v1/execute", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", nonce)
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(body))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash(body), body))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestExecuteRebuildsCodexIdentityHeaders(t *testing.T) {
	var got http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "account-token", ChatGPTAccountID: "chatgpt-acct", Groups: []string{"1"}})
	response := signedExecute(t, cfg, httpServer.URL, Envelope{
		Dispatch: "dispatch_identity", RequestID: "request_identity", Nonce: "identity", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test",
		Body:  json.RawMessage(`{"model":"gpt-test"}`),
		Scope: Scope{GroupIDs: []int64{1}},
		Headers: map[string]string{
			"Authorization":           "Bearer client-key",
			"originator":              "caller",
			"User-Agent":              "caller-agent/1.0",
			"version":                 "9.9.9",
			"chatgpt-account-id":      "caller-acct",
			"x-codex-installation-id": "caller-install",
			"session-id":              "sess_1",
			"x-codex-turn-metadata":   `{"kind":"turn","installation_id":"caller-install"}`,
			"x-forwarded-for":         "10.0.0.1",
			"traceparent":             "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			"baggage":                 "k=v",
			"x-openai-fedramp":        "true",
			// 账号路由覆盖只取部署配置，调用方的值不透传（CPR e7c24781）
			"x-openai-account-routing-override": "caller-route",
		},
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, data)
	}
	want := map[string]string{
		"Authorization":         "Bearer account-token",
		"Originator":            "Codex Desktop",
		"User-Agent":            server.globalProfile().userAgent(),
		"Version":               server.globalProfile().CodexVersion,
		"Chatgpt-Account-Id":    "chatgpt-acct",
		"X-Codex-Turn-Metadata": `{"kind":"turn","installation_id":"` + installationOf(t, server, "acct_1") + `"}`,
		// 安装头与 client_metadata 共用本账号安装身份，不继承调用方的值（CPR 2016bda0）
		"X-Codex-Installation-Id": installationOf(t, server, "acct_1"),
		"Traceparent":             "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		"Baggage":                 "k=v",
		"X-Openai-Fedramp":        "true",
	}
	for key, value := range want {
		if got.Get(key) != value {
			t.Fatalf("%s=%q want %q (headers=%v)", key, got.Get(key), value, got)
		}
	}
	// 关联 ID 按账号 installation id 映射为稳定 UUID，不透传原值
	if got.Get("Session-Id") == "" || got.Get("Session-Id") == "sess_1" || len(got.Get("Session-Id")) != 36 {
		t.Fatalf("session-id not scoped: %q", got.Get("Session-Id"))
	}
	// 控制面记录的出站 Session 与实际发往上游的值一致
	if response.Header.Get(outboundSessionHeader) != got.Get("Session-Id") {
		t.Fatalf("outbound session header=%q upstream=%q", response.Header.Get(outboundSessionHeader), got.Get("Session-Id"))
	}
	for _, key := range []string{"X-Forwarded-For", "X-Openai-Account-Routing-Override"} {
		if got.Get(key) != "" {
			t.Fatalf("%s leaked upstream: %v", key, got)
		}
	}
}

func TestSearchUsesAlphaSearchEndpoint(t *testing.T) {
	var path string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"results":[]}`)
	}))
	defer upstream.Close()
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}})
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_search", RequestID: "request_search", Nonce: "search", Operation: "search", Protocol: "openai.search", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}}})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || path != "/alpha/search" {
		t.Fatalf("status=%d path=%q", response.StatusCode, path)
	}
}

func TestExecuteReleasesAccountOnceOnCopyError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"id\":")
		_ = buf.Flush()
		_ = conn.Close()
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", MaxConcurrency: 4, Groups: []string{"1"}})
	// 模拟同一账号上另一个仍在进行的请求。
	if _, err := server.store.Select(Scope{GroupIDs: []int64{1}}, "gpt-test", nil); err != nil {
		t.Fatal(err)
	}
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_copy", RequestID: "request_copy", Nonce: "copy", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}}})
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	account, _ := server.store.Get("acct_1")
	if account.InFlight != 1 {
		t.Fatalf("in-flight=%d want 1 (the concurrent request must stay counted)", account.InFlight)
	}
	if account.LastError == "" {
		t.Fatal("copy error was not recorded")
	}
}

func TestExecuteFlushesStreamEvents(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1}}}\n\n")
	}))
	defer upstream.Close()
	defer close(release)
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}})
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_stream", RequestID: "request_stream", Nonce: "stream", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(`{"model":"gpt-test","stream":true}`), Scope: Scope{GroupIDs: []int64{1}}})
	defer response.Body.Close()
	first := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(response.Body).ReadString('\n')
		first <- line
	}()
	select {
	case line := <-first:
		if !strings.Contains(line, "response.created") {
			t.Fatalf("first line=%q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first SSE event was buffered instead of flushed")
	}
}

func TestSOCKS5ProxyUsesURLCredentials(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	proxyAddr, credentials := startSOCKS5Proxy(t)
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", ProxyURL: "socks5://proxy-user:proxy-pass@" + proxyAddr, Groups: []string{"1"}})
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_socks", RequestID: "request_socks", Nonce: "socks", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test"}`), Scope: Scope{GroupIDs: []int64{1}}})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, data)
	}
	if got := credentials(); got != "proxy-user:proxy-pass" {
		t.Fatalf("proxy credentials=%q", got)
	}
}

// startSOCKS5Proxy 是只接受用户名密码认证的最小 SOCKS5 CONNECT 代理。
func startSOCKS5Proxy(t *testing.T) (string, func() string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	var mu sync.Mutex
	var seen string
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				header := make([]byte, 2)
				if _, err := io.ReadFull(reader, header); err != nil {
					return
				}
				methods := make([]byte, header[1])
				if _, err := io.ReadFull(reader, methods); err != nil || !bytes.Contains(methods, []byte{0x02}) {
					_, _ = conn.Write([]byte{0x05, 0xff})
					return
				}
				_, _ = conn.Write([]byte{0x05, 0x02})
				readField := func() string {
					size, _ := reader.ReadByte()
					value := make([]byte, size)
					_, _ = io.ReadFull(reader, value)
					return string(value)
				}
				_, _ = reader.ReadByte()
				user, pass := readField(), readField()
				mu.Lock()
				seen = user + ":" + pass
				mu.Unlock()
				_, _ = conn.Write([]byte{0x01, 0x00})
				request := make([]byte, 4)
				if _, err := io.ReadFull(reader, request); err != nil {
					return
				}
				var host string
				switch request[3] {
				case 0x01:
					ip := make([]byte, 4)
					_, _ = io.ReadFull(reader, ip)
					host = net.IP(ip).String()
				case 0x03:
					host = readField()
				default:
					return
				}
				portBytes := make([]byte, 2)
				_, _ = io.ReadFull(reader, portBytes)
				target, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(int(binary.BigEndian.Uint16(portBytes)))))
				if err != nil {
					_, _ = conn.Write([]byte{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
					return
				}
				defer target.Close()
				_, _ = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
				go func() { _, _ = io.Copy(target, reader) }()
				_, _ = io.Copy(conn, target)
			}(conn)
		}
	}()
	return listener.Addr().String(), func() string {
		mu.Lock()
		defer mu.Unlock()
		return seen
	}
}

func TestDrainDeadlineCancelsInFlightStreams(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer close(release)
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}})
	done := make(chan *http.Response, 1)
	go func() {
		done <- signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "dispatch_drain", RequestID: "request_drain", Nonce: "drain", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(`{"model":"gpt-test","stream":true}`), Scope: Scope{GroupIDs: []int64{1}}})
	}()
	time.Sleep(200 * time.Millisecond)
	body, _ := json.Marshal(map[string]any{"deadline": time.Now().Add(200 * time.Millisecond).UTC().Format(time.RFC3339Nano)})
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/internal/v1/drain", bytes.NewReader(body))
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", "drain-nonce")
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(body))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, "drain-nonce", BodyHash(body), body))
	drainResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	drainResp.Body.Close()
	var response *http.Response
	select {
	case response = <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("drain deadline did not cancel the in-flight stream")
	}
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	var receipt map[string]any
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if data, err := os.ReadFile(filepath.Join(cfg.ReceiptDir(), "dispatch_drain.json")); err == nil {
			_ = json.Unmarshal(data, &receipt)
			break
		}
	}
	if receipt["terminal_state"] != terminalCancelled || receipt["error_code"] != "drain_deadline" {
		t.Fatalf("receipt=%v", receipt)
	}
	if atomic.LoadInt64(&server.active) != 0 {
		t.Fatalf("active=%d", atomic.LoadInt64(&server.active))
	}
}

func installationOf(t *testing.T, server *Server, id string) string {
	t.Helper()
	account, ok := server.store.Get(id)
	if !ok {
		t.Fatalf("account %s missing", id)
	}
	return account.InstallationID
}

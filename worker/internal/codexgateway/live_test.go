package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeLiveUpstream 同时扮演 chatgpt.com realtime calls 引导与 api.openai.com 的 sideband/hangup。
type fakeLiveUpstream struct {
	mu        sync.Mutex
	calls     []http.Header
	bodies    []string
	sidebands []string
	hangups   []string
}

func (f *fakeLiveUpstream) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/realtime/calls") && r.Method == http.MethodPost:
			data, _ := io.ReadAll(r.Body)
			f.mu.Lock()
			f.calls = append(f.calls, r.Header.Clone())
			f.bodies = append(f.bodies, r.URL.RawQuery+"|"+string(data))
			f.mu.Unlock()
			w.Header().Set("Location", "/v1/realtime/calls/rtc_abc123")
			w.Header().Set("Content-Type", "application/sdp")
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, "v=0 answer")
		case strings.HasSuffix(r.URL.Path, "/hangup"):
			f.mu.Lock()
			f.hangups = append(f.hangups, r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(http.StatusOK)
		case strings.Contains(r.URL.Path, "/live/") || strings.Contains(r.URL.Path, "/realtime/calls/"):
			f.mu.Lock()
			f.sidebands = append(f.sidebands, r.URL.Path+"|"+r.Header.Get("Authorization"))
			f.mu.Unlock()
			if strings.HasSuffix(r.URL.Path, "/gone") {
				w.WriteHeader(http.StatusGone)
				return
			}
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"realtime"}, CompressionMode: websocket.CompressionDisabled})
			if err != nil {
				return
			}
			defer conn.CloseNow()
			for {
				kind, data, err := conn.Read(context.Background())
				if err != nil {
					return
				}
				_ = conn.Write(context.Background(), kind, append([]byte("echo:"), data...))
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func signedLiveSideband(t *testing.T, cfg Config, baseURL string, input liveSidebandRequest) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	data, _ := json.Marshal(input)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce := fmt.Sprintf("live-%d", nonceSeq.Add(1))
	header := http.Header{}
	header.Set("X-Kin-Gateway-Live", string(data))
	header.Set("x-kin-gateway-timestamp", timestamp)
	header.Set("x-kin-gateway-nonce", nonce)
	header.Set("x-kin-gateway-body-sha256", BodyHash(data))
	header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash(data), data))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, strings.Replace(baseURL, "http://", "ws://", 1)+"/internal/v1/live/sideband", &websocket.DialOptions{HTTPHeader: header, Subprotocols: input.Subprotocols})
}

func TestLiveCallPinsAccountForSidebandAndHangup(t *testing.T) {
	fake := &fakeLiveUpstream{}
	upstream := httptest.NewServer(fake.handler())
	t.Cleanup(upstream.Close)
	gw, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok_a"), Account{ID: "k", Enabled: true, APIKey: "sk", Groups: []string{"1"}})
	gw.cfg.LiveAPIBaseURL = upstream.URL + "/v1"

	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{
		Dispatch: fmt.Sprintf("d_live_%d", n), RequestID: fmt.Sprintf("r_live_%d", n), Nonce: fmt.Sprintf("n_live_%d", n),
		Operation: "live", Protocol: "openai.live", Model: "gpt-live-1-codex", ClientScope: "key_1",
		Headers: map[string]string{"content-type": "application/json", "x-codex-turn-state": "ts", "x-codex-routing-hint": "model=x", "x-codex-turn-metadata": `{"turn_state":"t","kind":"k"}`},
		Body:    json.RawMessage(`{"sdp":"v=0 offer","session":{"model":"gpt-live-1-codex"}}`), Scope: Scope{GroupIDs: []int64{1}},
	})
	answer, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusCreated || string(answer) != "v=0 answer" || response.Header.Get("Location") == "" || response.Header.Get("X-Kin-Gateway-Account") != "a" {
		t.Fatalf("call status=%d body=%s headers=%v", response.StatusCode, answer, response.Header)
	}
	fake.mu.Lock()
	callHeader, body := fake.calls[0], fake.bodies[0]
	fake.mu.Unlock()
	if !strings.HasPrefix(body, liveCallsQuery+"|") || !strings.Contains(body, `"sdp":"v=0 offer"`) {
		t.Fatalf("upstream body=%s", body)
	}
	if callHeader.Get("Authorization") != "Bearer tok_a" || callHeader.Get("x-codex-turn-state") != "" || callHeader.Get("x-codex-routing-hint") != "" || strings.Contains(callHeader.Get("x-codex-turn-metadata"), "turn_state") {
		t.Fatalf("live headers=%v", callHeader)
	}

	// 其他调用方不能接入；同一调用方接入后帧双向中继
	if _, resp, err := signedLiveSideband(t, cfg, httpServer.URL, liveSidebandRequest{CallID: "rtc_abc123", Style: "live", ClientScope: "key_2"}); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign caller joined the call: %v %v", err, resp)
	}
	conn, _, err := signedLiveSideband(t, cfg, httpServer.URL, liveSidebandRequest{CallID: "rtc_abc123", Style: "realtime_calls", ClientScope: "key_1", Subprotocols: []string{"realtime"}})
	if err != nil {
		t.Fatal(err)
	}
	if conn.Subprotocol() != "realtime" {
		t.Fatalf("subprotocol=%q", conn.Subprotocol())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"session.update"}`)); err != nil {
		t.Fatal(err)
	}
	if _, data, err := conn.Read(ctx); err != nil || string(data) != `echo:{"type":"session.update"}` {
		t.Fatalf("relay=%s %v", data, err)
	}
	// 同一时间只允许一条 sideband
	if _, resp, err := signedLiveSideband(t, cfg, httpServer.URL, liveSidebandRequest{CallID: "rtc_abc123", ClientScope: "key_1"}); err == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("concurrent sideband allowed: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
	fake.mu.Lock()
	sideband := fake.sidebands[0]
	fake.mu.Unlock()
	if sideband != "/v1/realtime/calls/rtc_abc123|Bearer tok_a" {
		t.Fatalf("sideband upstream=%s", sideband)
	}

	// hangup 只复验调用方，成功后删除登记
	resp, _ := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/live/hangup", map[string]any{"call_id": "rtc_abc123", "client_scope": "key_1"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("hangup status=%d", resp.StatusCode)
	}
	if _, err := gw.live.peek("rtc_abc123", "key_1"); err != errLiveCallMissing {
		t.Fatalf("call still registered after hangup: %v", err)
	}
}

func TestCallIDFromLocation(t *testing.T) {
	for location, want := range map[string]string{
		"rtc_1":          "rtc_1",
		"/v1/live/rtc_2": "rtc_2",
		"https://x/v1/realtime/calls/rtc_3?foo=1":       "rtc_3",
		"/v1/realtime?call_id=rtc_4&intent=quicksilver": "rtc_4",
		"https://x/bad/../":                             "",
	} {
		if got := callIDFromLocation(location); got != want {
			t.Fatalf("%s: got %q want %q", location, got, want)
		}
	}
}

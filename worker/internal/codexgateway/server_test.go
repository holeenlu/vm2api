package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExecuteWritesReceiptAndUsage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-codex-primary-used-percent", "12")
		w.Header().Set("x-codex-primary-window-minutes", "10080")
		w.Header().Set("x-codex-secondary-used-percent", "4")
		w.Header().Set("x-codex-secondary-window-minutes", "300")
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1","usage":{"input_tokens":2,"output_tokens":3}}`)
	}))
	defer upstream.Close()

	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstream.URL, RequestTimeoutSec: 5}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.store.Upsert(Account{ID: "acct_1", Enabled: true, AccessToken: "token", Groups: []string{"1"}}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	envelope := Envelope{Version: 1, Dispatch: "dispatch_1", RequestID: "request_1", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","stream":false}`), ExpiresAt: time.Now().Add(time.Minute), Nonce: "nonce_1", Scope: Scope{GroupIDs: []int64{1}}}
	body, _ := json.Marshal(envelope)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/internal/v1/execute", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", "http_nonce_1")
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(body))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, "http_nonce_1", BodyHash(body), body))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", response.StatusCode)
	}
	if response.Header.Get("X-Kin-Gateway-Account") != "acct_1" || response.Header.Get("X-Kin-Gateway-Credential-Revision") == "" {
		t.Fatalf("missing account identity headers: %v", response.Header)
	}
	data, _ := io.ReadAll(response.Body)
	if !bytes.Contains(data, []byte(`"output_tokens":3`)) {
		t.Fatalf("body=%s", data)
	}
	files, err := filepath.Glob(filepath.Join(cfg.ReceiptDir(), "dispatch_1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("receipt files=%v", files)
	}
}

func TestDrainingExecuteIsMarkedNotSent(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: "http://127.0.0.1:1", RequestTimeoutSec: 5}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	server.draining = true
	server.mu.Unlock()
	recorder := httptest.NewRecorder()
	server.execute(recorder, httptest.NewRequest(http.MethodPost, "/internal/v1/execute", bytes.NewReader(nil)))
	if recorder.Code != http.StatusServiceUnavailable || recorder.Header().Get(sendStateHeader) != sendStateNotSent {
		t.Fatalf("status=%d send_state=%q", recorder.Code, recorder.Header().Get(sendStateHeader))
	}
}

func TestReceiptFixtureMatchesCanonicalPayloadHash(t *testing.T) {
	data, err := os.ReadFile("testdata/receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	claimed, ok := value["payload_hash"].(string)
	if !ok || claimed == "" {
		t.Fatalf("fixture payload_hash=%#v", value["payload_hash"])
	}
	delete(value, "payload_hash")
	canonical, err := marshalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	if got := BodyHash(canonical); got != claimed {
		t.Fatalf("payload hash=%s want=%s canonical=%s", got, claimed, canonical)
	}
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	hash := BodyHash(data)
	signature := Sign("fixture-secret", now.Format(time.RFC3339Nano), "fixture-nonce", hash, data)
	if err := Verify("fixture-secret", now.Format(time.RFC3339Nano), "fixture-nonce", hash, signature, data, now, time.Second); err != nil {
		t.Fatal(err)
	}
}

// 控制面 custody.mjs 与 Worker 的共享凭据包逐字节一致（夹具由控制面生成）
func TestCredentialBundleFromTheControlPlaneOpens(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "fixtures", "executor-contract", "credential-bundle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		AccountID        string           `json:"account_id"`
		Bundle           credentialBundle `json:"bundle"`
		BundleKey        string           `json:"bundle_key"`
		CredentialBundle string           `json:"credential_bundle"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{CredentialBundleKey: fixture.BundleKey}}
	if opened, err := s.openCredentialBundle(fixture.CredentialBundle, fixture.AccountID); err != nil || opened != fixture.Bundle {
		t.Fatalf("credential opened=%+v err=%v", opened, err)
	}
}

func TestAccountExportUsesOpaqueCredentialBundle(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", CredentialBundleKey: "cluster-shared-key"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.store.Upsert(Account{ID: "acct_export", Enabled: true, AccessToken: "access-secret", RefreshToken: "refresh-secret", ProxyURL: "socks5://user:pass@example.test:1080"}); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	body := []byte(`{}`)
	request := func(method, path string, payload []byte) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(method, httpServer.URL+path, bytes.NewReader(payload))
		timestamp := time.Now().UTC().Format(time.RFC3339Nano)
		req.Header.Set("x-kin-gateway-timestamp", timestamp)
		req.Header.Set("x-kin-gateway-nonce", "nonce-"+path)
		req.Header.Set("x-kin-gateway-body-sha256", BodyHash(payload))
		req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, "nonce-"+path, BodyHash(payload), payload))
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := request(http.MethodGet, "/internal/v1/accounts/acct_export/export", body)
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if bytes.Contains(data, []byte("access-secret")) || bytes.Contains(data, []byte("refresh-secret")) {
		t.Fatalf("export leaked credential: %s", data)
	}
	var exported map[string]any
	if err := json.Unmarshal(data, &exported); err != nil {
		t.Fatal(err)
	}
	bundle, ok := exported["credential_bundle"].(string)
	if !ok || bundle == "" {
		t.Fatalf("missing credential bundle: %#v", exported)
	}
	// 控制面用同一把凭据包密钥解开（收录进凭据库）
	opened, err := server.openCredentialBundle(bundle, "acct_export")
	if err != nil || opened.AccessToken != "access-secret" || opened.RefreshToken != "refresh-secret" || opened.ProxyURL == "" {
		t.Fatalf("credential bundle = %#v err=%v", opened, err)
	}
}

func TestServeShutsDownGracefullyAndFlushesRuntimeState(t *testing.T) {
	withRuntimeFlushDelay(t, time.Hour)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", CredentialBundleKey: "bundle-key", UpstreamBaseURL: "http://127.0.0.1:1", RequestTimeoutSec: 5, Listen: addr}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.store.Upsert(Account{ID: "acct", Enabled: true, AccessToken: "tok"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx) }()
	for i := 0; i < 100; i++ {
		if conn, err := net.Dial("tcp", addr); err == nil {
			_ = conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// 延迟落盘的运行时状态在退出时写出
	server.store.UpdateQuota("acct", map[string]any{"primary_window": map[string]any{"used_percent": 42.0, "window_minutes": 300.0}})
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Serve returned %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return after cancellation")
	}
	reopened, err := OpenSealedStore(cfg.AccountsPath(), cfg.CredentialBundleKey)
	if err != nil {
		t.Fatal(err)
	}
	if account, _ := reopened.Get("acct"); account.Quota == nil {
		t.Fatal("runtime state was not flushed on shutdown")
	}
}

package codexgateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
	"github.com/klauspost/compress/zstd"
)

// bpsUpstream 同时模拟原生 Codex（/responses）与 BPS（/bps/responses），按令牌脚本应答并记录请求。
type bpsUpstream struct {
	mu       sync.Mutex
	scripts  map[string][]func(http.ResponseWriter)
	calls    map[string]int
	paths    []string
	bodies   map[string][]byte
	headers  map[string]http.Header
	sequence []string
}

func newBPSUpstream(t *testing.T, scripts map[string][]func(http.ResponseWriter)) (*bpsUpstream, *httptest.Server) {
	t.Helper()
	u := &bpsUpstream{scripts: scripts, calls: map[string]int{}, bodies: map[string][]byte{}, headers: map[string]http.Header{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		index := u.calls[token]
		u.calls[token]++
		u.paths = append(u.paths, r.URL.Path)
		u.sequence = append(u.sequence, token)
		u.bodies[token] = body
		u.headers[token] = r.Header.Clone()
		steps := u.scripts[token]
		u.mu.Unlock()
		if len(steps) == 0 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		steps[min(index, len(steps)-1)](w)
	}))
	t.Cleanup(server.Close)
	return u, server
}

func (u *bpsUpstream) count(token string) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls[token]
}

func newBPSExecuteServer(t *testing.T, upstreamURL string, accounts ...Account) (*Server, *httptest.Server, Config) {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: upstreamURL, BPSBaseURL: upstreamURL + "/bps", UpstreamTransport: "http", RequestTimeoutSec: 5}
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

// bpsAccount 是带 BPS 附加授权的 OAuth 账号：原生令牌 token，BPS 令牌 bps_<token>，models 走 BPS。
func bpsAccount(id, token string, models ...string) Account {
	account := account(id, token)
	account.ChatGPTAccountID = "chatgpt-" + id
	if len(models) == 0 {
		models = []string{"gpt-test"}
	}
	account.BPS = &BPSGrant{AccessToken: "bps_" + token, RefreshToken: "bps_rt_" + token, Revision: 1, ExpiresAt: time.Now().Add(time.Hour)}
	account.BPSSettings = &BPSSettings{Enabled: true, Models: models, AutoDisableOn403: true}
	return account
}

var bpsOn = SchedulingPolicy{BPSEnabled: true}

func nativeReply(text string) func(http.ResponseWriter) {
	return sseReply(`{"type":"response.created","response":{"id":"r_native"}}`, `{"type":"response.output_text.delta","delta":"`+text+`"}`, `{"type":"response.completed","response":{"id":"r_native","usage":{"input_tokens":1,"output_tokens":1}}}`)
}

func bpsEvent(payload map[string]any) string {
	raw, _ := json.Marshal(payload)
	return "event: " + payload["type"].(string) + "\ndata: " + string(raw) + "\n\n"
}

func bpsTextReply(id, text string) func(http.ResponseWriter) {
	message := map[string]any{"type": "message", "id": "msg_" + id, "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": id, "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "message", "id": "msg_" + id, "role": "assistant", "content": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg_" + id, "delta": text})+
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": message})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": id, "status": "completed", "output": []any{message}, "usage": map[string]any{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}}}))
	}
}

func runBody(t *testing.T, cfg Config, baseURL, body string, policy SchedulingPolicy) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, baseURL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, Scheduling: policy})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

const bpsTextRequest = `{"model":"gpt-test","stream":true,"instructions":"be brief","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`

func TestBPSListedModelUsesTheBPSChannelOfTheSameAccount(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("resp_bps", "hello")}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "hello") || upstream.count("tok_a") != 0 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if response.Header.Get(authModeHeader) != "bps" || attemptsOf(t, response)[0].Route != "bps" {
		t.Fatalf("auth mode=%q attempts=%s", response.Header.Get(authModeHeader), response.Header.Get(attemptsHeader))
	}
	// 使用记录的上游端点：BPS 通道回报 BPS Responses 路径与 HTTP 传输
	if got, transport := response.Header.Get(upstreamPathHeader), response.Header.Get(upstreamTransportHeader); got != "/bps/responses" || transport != "http" {
		t.Fatalf("upstream path=%q transport=%q", got, transport)
	}
	header := upstream.headers["bps_tok_a"]
	if upstream.paths[0] != "/bps/responses" || header.Get("X-Basispoints-Auth-Mode") != "chatgpt" || header.Get("Chatgpt-Account-Id") != "chatgpt-a" || header.Get("Originator") != "" {
		t.Fatalf("path=%v headers=%v", upstream.paths, header)
	}
	var sent map[string]any
	if err := json.Unmarshal(upstream.bodies["bps_tok_a"], &sent); err != nil || sent["model_selection"] != "explicit" || sent["instructions"] != nil {
		t.Fatalf("BPS body=%s err=%v", upstream.bodies["bps_tok_a"], err)
	}
}

func TestBPSIsSkippedWhenModelUnlistedOrSwitchedOff(t *testing.T) {
	for name, tc := range map[string]struct {
		account Account
		policy  SchedulingPolicy
	}{
		"unlisted model": {bpsAccount("a", "tok_a", "gpt-other"), bpsOn},
		"global off":     {bpsAccount("a", "tok_a"), SchedulingPolicy{}},
		"account off": {func() Account {
			a := bpsAccount("a", "tok_a")
			a.BPSSettings.Enabled = false
			return a
		}(), bpsOn},
		"no grant": {func() Account {
			a := bpsAccount("a", "tok_a")
			a.BPS = nil
			return a
		}(), bpsOn},
	} {
		t.Run(name, func(t *testing.T) {
			upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "bps")}, "tok_a": {nativeReply("native")}})
			_, httpServer, cfg := newBPSExecuteServer(t, server.URL, tc.account)
			response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, tc.policy)
			if response.StatusCode != 200 || upstream.count("bps_tok_a") != 0 || upstream.count("tok_a") != 1 || response.Header.Get(authModeHeader) != "native" {
				t.Fatalf("status=%d calls bps=%d native=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("tok_a"), body)
			}
		})
	}
}

func TestBPSFailureTriesOtherBPSThenNativeWithoutTouchingNativeHealth(t *testing.T) {
	limited := jsonReply(429, `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"slow down"}}`, "Retry-After", "30")
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {limited}, "bps_tok_b": {limited},
		"tok_a": {nativeReply("native")}, "tok_b": {nativeReply("native")},
	})
	gw, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "native") || response.Header.Get(authModeHeader) != "native" {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	// BPS 用尽后转原生：回报的是最终承接请求的原生路径
	if got := response.Header.Get(upstreamPathHeader); got != "/responses" {
		t.Fatalf("upstream path=%q", got)
	}
	if len(upstream.sequence) != 3 || !strings.HasPrefix(upstream.sequence[0], "bps_") || !strings.HasPrefix(upstream.sequence[1], "bps_") || strings.HasPrefix(upstream.sequence[2], "bps_") {
		t.Fatalf("sequence=%v", upstream.sequence)
	}
	for _, id := range []string{"a", "b"} {
		saved, _ := gw.store.Get(id)
		if !saved.BPS.CooldownUntil.After(time.Now().Add(20*time.Second)) || !saved.CooldownUntil.IsZero() || saved.LastError != "" {
			t.Fatalf("%s: BPS should cool, native untouched: %+v", id, publicAccount(saved))
		}
	}
	// BPS 冷却期间同模型直接走原生
	again, _ := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if again.StatusCode != 200 || upstream.count("bps_tok_a")+upstream.count("bps_tok_b") != 2 {
		t.Fatalf("cooled BPS channel was retried: %v", upstream.sequence)
	}
}

func TestBPSSkipsRequestsItCannotCarry(t *testing.T) {
	for name, body := range map[string]string{
		"continuation": `{"model":"gpt-test","stream":true,"previous_response_id":"resp_prev","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`,
		"broken image": `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}]}`,
		"image_tool":   `{"model":"gpt-test","stream":true,"tools":[{"type":"image_generation"}],"input":"draw"}`,
	} {
		t.Run(name, func(t *testing.T) {
			upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "bps")}, "tok_a": {nativeReply("native")}})
			_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
			response, data := runBody(t, cfg, httpServer.URL, body, bpsOn)
			if response.StatusCode != 200 || upstream.count("bps_tok_a") != 0 || upstream.count("tok_a") != 1 {
				t.Fatalf("status=%d calls bps=%d native=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("tok_a"), data)
			}
		})
	}
}

func TestBPSHostedToolAndEncryptedContentSwitches(t *testing.T) {
	hosted := `{"model":"gpt-test","stream":true,"tools":[{"type":"web_search"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`
	encrypted := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"assistant","content":[{"type":"encrypted_content","encrypted_content":"gAAAA-secret"}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`
	for name, tc := range map[string]struct {
		body    string
		enable  func(*BPSSettings)
		viaBPS  bool
		noValue string
	}{
		"hosted tool off": {hosted, func(*BPSSettings) {}, false, ""},
		"hosted tool on":  {hosted, func(s *BPSSettings) { s.OmitUnsupportedTools = true }, true, `"web_search"`},
		"encrypted off":   {encrypted, func(*BPSSettings) {}, false, ""},
		"encrypted on":    {encrypted, func(s *BPSSettings) { s.IgnoreEncryptedContent = true }, true, "gAAAA-secret"},
	} {
		t.Run(name, func(t *testing.T) {
			upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "bps")}, "tok_a": {nativeReply("native")}})
			acct := bpsAccount("a", "tok_a")
			tc.enable(acct.BPSSettings)
			_, httpServer, cfg := newBPSExecuteServer(t, server.URL, acct)
			response, data := runBody(t, cfg, httpServer.URL, tc.body, bpsOn)
			if response.StatusCode != 200 || (upstream.count("bps_tok_a") == 1) != tc.viaBPS {
				t.Fatalf("status=%d bps=%d native=%d body=%s", response.StatusCode, upstream.count("bps_tok_a"), upstream.count("tok_a"), data)
			}
			if tc.noValue != "" && strings.Contains(string(upstream.bodies["bps_tok_a"]), tc.noValue) {
				t.Fatalf("BPS body still carries %s: %s", tc.noValue, upstream.bodies["bps_tok_a"])
			}
		})
	}
}

func TestBPSModelDeniedCoolsOnlyTheBPSModel(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {jsonReply(403, `{"error":{"type":"invalid_request_error","code":"model_not_allowed","message":"no access"}}`)},
		"tok_a":     {nativeReply("native")},
	})
	gw, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 || upstream.count("tok_a") != 1 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	saved, _ := gw.store.Get("a")
	if !saved.BPS.ModelCooldowns["gpt-test"].After(time.Now().Add(20*time.Minute)) || len(saved.ModelCooldowns) != 0 || saved.BPS.State != "" {
		t.Fatalf("model denial must cool only the BPS model: %+v", publicAccount(saved))
	}
}

func TestBPSAccountLevel403FollowsTheAutoDisableSwitch(t *testing.T) {
	for _, autoDisable := range []bool{true, false} {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
			"bps_tok_a": {jsonReply(403, `{"error":{"code":"account_deactivated","message":"deactivated"}}`)},
			"tok_a":     {nativeReply("native")},
		})
		acct := bpsAccount("a", "tok_a")
		acct.BPSSettings.AutoDisableOn403 = autoDisable
		gw, httpServer, cfg := newBPSExecuteServer(t, server.URL, acct)
		if response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn); response.StatusCode != 200 || upstream.count("tok_a") != 1 {
			t.Fatalf("status=%d body=%s", response.StatusCode, body)
		}
		saved, _ := gw.store.Get("a")
		if blocked := saved.BPS.State == bpsStateBlocked; blocked != autoDisable || saved.CredentialState != "" {
			t.Fatalf("autoDisable=%v state=%q native=%q", autoDisable, saved.BPS.State, saved.CredentialState)
		}
	}
}

func TestBPSUsageLimitIsSharedWithTheNativeChannel(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {jsonReply(429, `{"error":{"type":"usage_limit_reached","message":"limit","resets_at":4102444800}}`)},
		"tok_a":     {nativeReply("native")},
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, _ := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 429 || upstream.count("tok_a") != 0 {
		t.Fatalf("exhausted quota must skip the native channel too: status=%d native=%d", response.StatusCode, upstream.count("tok_a"))
	}
}

func TestBPSServesWhileTheNativeCredentialIsUnavailable(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "bps")}})
	acct := bpsAccount("a", "tok_a")
	acct.CredentialState = "expired"
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, acct)
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 || upstream.count("bps_tok_a") != 1 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}

func TestBPSInStreamFailureBeforeOutputFallsBackToNative(t *testing.T) {
	failed := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r1", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.failed", "response": map[string]any{"id": "r1", "status": "failed", "output": []any{}, "error": map[string]any{"code": "rate_limit_exceeded", "message": "busy"}}}))
	}
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {failed}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 || strings.Contains(string(body), "response.failed") || upstream.count("tok_a") != 1 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}

func TestBPSFunctionToolRoundTripThroughWorker(t *testing.T) {
	code, _ := json.Marshal(map[string]any{"name": "get_weather", "arguments": map[string]any{"city": "Tokyo"}})
	arguments, _ := json.Marshal(map[string]any{"code": string(code), "summary": "Call client tool", "extended_summary": "", "destructive": false, "references": []any{}})
	native := map[string]any{"type": "function_call", "id": "fc_native", "call_id": "call_1", "name": "run_officejs", "arguments": string(arguments), "status": "completed"}
	reply := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r1", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": native})+
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": native})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r1", "status": "completed", "output": []any{native}, "usage": map[string]any{"input_tokens": 5, "output_tokens": 2}}}))
	}
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {reply}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"tools":[{"type":"function","name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"weather?"}]}]}`
	response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
	if response.StatusCode != 200 || strings.Contains(string(body), "run_officejs") || !strings.Contains(string(body), `"name":"get_weather"`) || !strings.Contains(string(body), "Tokyo") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if !strings.Contains(string(upstream.bodies["bps_tok_a"]), "get_weather") || strings.Contains(string(upstream.bodies["bps_tok_a"]), `"tools"`) {
		t.Fatalf("catalog must travel as developer text, not tools: %s", upstream.bodies["bps_tok_a"])
	}
}

func jwtFixture(claims map[string]any) string {
	raw, _ := json.Marshal(claims)
	return "h." + base64.RawURLEncoding.EncodeToString(raw) + ".s"
}

// excelTokens 构造一次 Excel 授权的 AT 与 id_token（签发给 Excel 客户端，AT 一小时后过期）。
func excelTokens(workspace, user, email, plan string) (string, string) {
	const client = "app_fnr0pYvVwwFDocDumLG3H2Bp"
	auth := map[string]any{"chatgpt_account_id": workspace, "chatgpt_user_id": user, "chatgpt_plan_type": plan}
	access := jwtFixture(map[string]any{"client_id": client, "exp": time.Now().Add(time.Hour).Unix(), "https://api.openai.com/auth": auth})
	identity := jwtFixture(map[string]any{"aud": []any{client}, "email": email, "https://api.openai.com/auth": auth})
	return access, identity
}

func TestBPSOAuthAddsTheGrantToAnExistingOAuthAccount(t *testing.T) {
	var form url.Values
	workspace, user, email, plan := "chatgpt-a", "user-a", "a@example.com", "pro"
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.Form
		access, identity := excelTokens(workspace, user, email, plan)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": access, "refresh_token": "bps-refresh", "id_token": identity, "expires_in": 3600})
	}))
	defer provider.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: provider.URL}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.oauthStartRequest(map[string]any{"runtime_account_id": "missing", "grant": "bps", "session": testOAuthSession()}); err == nil {
		t.Fatal("BPS authorization must require an existing OAuth account")
	}
	native := account("a", "tok_a")
	native.ChatGPTAccountID = "chatgpt-a"
	native.Email = "A@example.com"
	native.IDToken = jwtFixture(map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "chatgpt-a", "chatgpt_user_id": "user-a"}})
	native.CredentialRevision = 3
	_, _ = server.store.Upsert(native)
	complete := func() error {
		started, err := server.oauthStartRequest(map[string]any{"draft_id": "d", "runtime_account_id": "a", "grant": "bps", "session": testOAuthSession()})
		if err != nil {
			return err
		}
		authURL, _ := url.Parse(started["auth_url"].(string))
		if authURL.Path != "/api/accounts/authorize" || authURL.Query().Get("client_id") != cfg.BPSClientID || started["flavor"] != "bps" {
			t.Fatalf("auth url=%s", authURL)
		}
		session := started["session"].(OAuthSession)
		_, err = server.oauthCompleteRequest(map[string]any{"session": session, "draft_id": "d", "callback": cfg.BPSRedirectURI + "?code=c&state=" + session.State})
		return err
	}
	if err := complete(); err != nil {
		t.Fatal(err)
	}
	if form.Get("client_id") != cfg.BPSClientID || form.Get("redirect_uri") != cfg.BPSRedirectURI {
		t.Fatalf("token exchange form=%v", form)
	}
	saved, _ := server.store.Get("a")
	if saved.AccessToken != "tok_a" || saved.CredentialRevision != 3 || saved.AuthType != "oauth" || saved.BPS == nil || saved.BPS.RefreshToken != "bps-refresh" || saved.BPS.Revision != 1 {
		t.Fatalf("BPS grant must be added without touching the native credential: %+v", saved)
	}
	workspace = "chatgpt-other"
	if err := complete(); err == nil || !strings.Contains(err.Error(), "different ChatGPT account") {
		t.Fatalf("identity mismatch err=%v", err)
	}
	// 同一 Team 工作区的其他成员：用户或邮箱与原生授权不一致都拒绝（对齐 sub2api validateExcelIdentity）
	workspace, user = "chatgpt-a", "user-b"
	if err := complete(); err == nil || !strings.Contains(err.Error(), "another user") {
		t.Fatalf("user mismatch err=%v", err)
	}
	user, email = "user-a", "b@example.com"
	if err := complete(); err == nil || !strings.Contains(err.Error(), "email") {
		t.Fatalf("email mismatch err=%v", err)
	}
	email, plan = "a@example.com", "free"
	if err := complete(); err == nil || !strings.Contains(err.Error(), "paid") {
		t.Fatalf("free plan err=%v", err)
	}
}

func TestBPSImportRevokeRefreshAndBundle(t *testing.T) {
	var refreshForm url.Values
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		refreshForm = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"bps_new","refresh_token":"bps_rt_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: tokenServer.URL, RequestTimeoutSec: 5, CredentialBundleKey: "bundle-key"}
	cfg.applyDefaults()
	gw, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	native := account("a", "tok_a")
	native.ChatGPTAccountID = "chatgpt-a"
	_, _ = gw.store.Upsert(native)
	httpServer := httptest.NewServer(gw.Handler())
	defer httpServer.Close()
	call := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, httpServer.URL+path, strings.NewReader(body))
		timestamp := time.Now().UTC().Format(time.RFC3339Nano)
		nonce := method + path + timestamp
		req.Header.Set("x-kin-gateway-timestamp", timestamp)
		req.Header.Set("x-kin-gateway-nonce", nonce)
		req.Header.Set("x-kin-gateway-body-sha256", BodyHash([]byte(body)))
		req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash([]byte(body)), []byte(body)))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(data)
	}
	excel, identity := excelTokens("chatgpt-a", "user-a", "a@example.com", "pro")
	foreign := jwtFixture(map[string]any{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "exp": time.Now().Add(time.Hour).Unix(), "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "chatgpt-a"}})
	expired := jwtFixture(map[string]any{"client_id": cfg.BPSClientID, "exp": time.Now().Add(-time.Minute).Unix(), "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "chatgpt-a"}})
	// 导入与 sub2api 同样严格：签发给其他客户端、已过期、缺 id_token 或刷新令牌都拒绝
	for name, body := range map[string]string{
		"foreign client":   `{"access_token":"` + foreign + `","refresh_token":"r","id_token":"` + identity + `"}`,
		"expired":          `{"access_token":"` + expired + `","refresh_token":"r","id_token":"` + identity + `"}`,
		"missing id_token": `{"access_token":"` + excel + `","refresh_token":"r"}`,
		"missing refresh":  `{"access_token":"` + excel + `","id_token":"` + identity + `"}`,
	} {
		if status, out := call("POST", "/internal/v1/accounts/a/bps/import", body); status != 400 || !strings.Contains(out, "bps_authorization_invalid") {
			t.Fatalf("%s: import status=%d body=%s", name, status, out)
		}
	}
	// AT 快到期（1 分钟内）以便下面的刷新器立即刷新
	excel = jwtFixture(map[string]any{"client_id": cfg.BPSClientID, "exp": time.Now().Add(time.Minute).Unix(), "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": "chatgpt-a", "chatgpt_user_id": "user-a"}})
	if status, body := call("POST", "/internal/v1/accounts/a/bps/import", `{"access_token":"`+excel+`","refresh_token":"bps_rt","id_token":"`+identity+`"}`); status != 200 || strings.Contains(body, "bps_rt") {
		t.Fatalf("import status=%d body=%s", status, body)
	}
	// AT 即将过期：刷新器用 Excel 客户端只刷新 BPS 授权
	gw.refreshDueBPS(context.Background(), time.Now())
	saved, _ := gw.store.Get("a")
	if refreshForm.Get("client_id") != cfg.BPSClientID || refreshForm.Get("scope") != bpsRefreshScope || saved.BPS.AccessToken != "bps_new" || saved.AccessToken != "tok_a" {
		t.Fatalf("refresh form=%v saved=%+v", refreshForm, saved.BPS)
	}
	// 凭据包带上 BPS 令牌，另一实例导入后可直接走 BPS
	bundle, err := gw.sealCredentialBundle(saved)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := gw.openCredentialBundle(bundle, "a")
	if err != nil || opened.BPSAccessToken != "bps_new" || opened.BPSRefreshToken != "bps_rt_new" {
		t.Fatalf("bundle=%+v err=%v", opened, err)
	}
	if status, _ := call("DELETE", "/internal/v1/accounts/a/bps", ""); status != 200 {
		t.Fatalf("revoke status=%d", status)
	}
	if revoked, _ := gw.store.Get("a"); revoked.BPS != nil || revoked.AccessToken != "tok_a" {
		t.Fatalf("revoke must remove only the BPS grant: %+v", revoked)
	}
}

func TestBPSBlockedGrantRecoversAfterAProbe(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("probe", "pong")}})
	acct := bpsAccount("a", "tok_a")
	acct.BPSSettings.AutoRecoverOn403 = true
	acct.BPSSettings.RecoveryIntervalMinutes = 1
	acct.BPS.State, acct.BPS.BlockedAt = bpsStateBlocked, time.Now().Add(-2*time.Minute)
	gw, _, _ := newBPSExecuteServer(t, server.URL, acct)
	gw.probeBlockedBPS(context.Background(), time.Now())
	saved, _ := gw.store.Get("a")
	if upstream.count("bps_tok_a") != 1 || saved.BPS.State != "" || !saved.BPS.BlockedAt.IsZero() {
		t.Fatalf("probe calls=%d state=%q", upstream.count("bps_tok_a"), saved.BPS.State)
	}
	// 未到间隔不探测
	acct.BPS.State, acct.BPS.BlockedAt = bpsStateBlocked, time.Now()
	_, _ = gw.store.Upsert(acct)
	gw.probeBlockedBPS(context.Background(), time.Now())
	if upstream.count("bps_tok_a") != 1 {
		t.Fatal("probe ran before the recovery interval")
	}
}

// BPS 总开关关闭（心跳 bps_enabled=false）时不做后台恢复探测；重新开启后照常探测
func TestBPSBackgroundProbesPauseWhileTheSwitchIsOff(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("probe", "pong")}})
	acct := bpsAccount("a", "tok_a")
	acct.BPSSettings.AutoRecoverOn403 = true
	acct.BPSSettings.RecoveryIntervalMinutes = 1
	acct.BPS.State, acct.BPS.BlockedAt = bpsStateBlocked, time.Now().Add(-2*time.Minute)
	gw, _, _ := newBPSExecuteServer(t, server.URL, acct)
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"bps_enabled":false}}`))
	gw.probeBlockedBPS(context.Background(), time.Now())
	if upstream.count("bps_tok_a") != 0 {
		t.Fatal("blocked grants must not be probed while BPS is switched off")
	}
	// 未下发该字段的心跳不改变开关
	gw.applyHeartbeatPolicy([]byte(`{"policy":{}}`))
	gw.probeBlockedBPS(context.Background(), time.Now())
	if upstream.count("bps_tok_a") != 0 {
		t.Fatal("a heartbeat without bps_enabled must keep the switch")
	}
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"bps_enabled":true}}`))
	gw.probeBlockedBPS(context.Background(), time.Now())
	if saved, _ := gw.store.Get("a"); upstream.count("bps_tok_a") != 1 || saved.BPS.State != "" {
		t.Fatalf("probe calls=%d state=%q", upstream.count("bps_tok_a"), saved.BPS.State)
	}
}

func TestBPSProjectionPatchKeepsTheGrant(t *testing.T) {
	gw, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	patched, err := gw.store.Patch("a", map[string]any{"bps_settings": map[string]any{"enabled": true, "models": []any{"gpt-x"}, "omit_unsupported_tools": true}})
	if err != nil || patched.BPS == nil || patched.BPS.AccessToken != "bps_tok_a" || !patched.BPSSettings.OmitUnsupportedTools || patched.BPSSettings.Models[0] != "gpt-x" {
		t.Fatalf("patched=%+v err=%v", patched, err)
	}
	projected := account("a", "")
	projected.Weight = 7
	saved, _ := gw.store.Upsert(projected)
	if saved.BPS == nil || saved.BPS.AccessToken != "bps_tok_a" || saved.BPSSettings == nil {
		t.Fatalf("projection dropped the BPS grant: %+v", saved)
	}
	if public := publicAccount(saved); public.BPS.AccessToken != "" || public.BPS.RefreshToken != "" {
		t.Fatal("public account leaked BPS tokens")
	}
}

func TestBPSCacheCreationIsBilledAsInputWhenEnabled(t *testing.T) {
	message := map[string]any{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "ok", "annotations": []any{}}}}
	reply := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "m", "delta": "ok"})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{message}, "usage": map[string]any{"input_tokens": 100, "output_tokens": 2, "input_tokens_details": map[string]any{"cached_tokens": 10, "cache_creation_tokens": 40}}}}))
	}
	for _, enabled := range []bool{true, false} {
		_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {reply}})
		acct := bpsAccount("a", "tok_a")
		acct.BPSSettings.CacheCreationAsInput = enabled
		_, httpServer, cfg := newBPSExecuteServer(t, server.URL, acct)
		response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
		zeroed := strings.Contains(string(body), `"cache_creation_tokens":0`)
		if response.StatusCode != 200 || zeroed != enabled || !strings.Contains(string(body), `"input_tokens":100`) {
			t.Fatalf("enabled=%v status=%d body=%s", enabled, response.StatusCode, body)
		}
	}
}

const bpsTestPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="

// bpsPathUpstream 按路径分别应答附件上传与 Responses，并记录请求体。
type bpsPathUpstream struct {
	mu          sync.Mutex
	uploads     int
	responses   [][]byte
	responseFns []func(http.ResponseWriter)
}

func newBPSPathUpstream(t *testing.T, responses ...func(http.ResponseWriter)) (*bpsPathUpstream, *httptest.Server) {
	t.Helper()
	u := &bpsPathUpstream{responseFns: responses}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		defer u.mu.Unlock()
		switch r.URL.Path {
		case "/bps/attachments":
			u.uploads++
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") || !bytes.Contains(body, []byte(`name="file"`)) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"openai_file_id": fmt.Sprintf("file-up%d", u.uploads)})
		case "/img.png":
			png, _ := base64.StdEncoding.DecodeString(bpsTestPNG)
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(png)
		case "/moved":
			http.Redirect(w, r, "/img.png", http.StatusFound)
		case "/page.html":
			w.Header().Set("Content-Type", "image/png")
			_, _ = io.WriteString(w, "<html>not an image</html>")
		case "/bps/responses":
			u.responses = append(u.responses, body)
			u.responseFns[min(len(u.responses)-1, len(u.responseFns)-1)](w)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return u, server
}

func TestBPSUploadsImagesAsAttachmentsAndReusesThem(t *testing.T) {
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"prompt_cache_key":"thread-1","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"what is this"},{"type":"input_image","image_url":"data:image/png;base64,` + bpsTestPNG + `"}]}]}`
	for i := 0; i < 2; i++ {
		response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
		if response.StatusCode != 200 || !strings.Contains(string(body), "seen") || response.Header.Get(authModeHeader) != "bps" {
			t.Fatalf("status=%d body=%s", response.StatusCode, body)
		}
	}
	if upstream.uploads != 1 {
		t.Fatalf("the same image of the same conversation should upload once, uploads=%d", upstream.uploads)
	}
	sent := string(upstream.responses[1])
	if !strings.Contains(sent, `"file_id":"file-up1"`) || strings.Contains(sent, "base64") {
		t.Fatalf("BPS body must reference the attachment instead of inline bytes: %s", sent)
	}
}

func TestBPSFileOwnershipFailureReuploadsOnce(t *testing.T) {
	ownership := jsonReply(500, `{"error":{"type":"server_error","code":"basispoints_file_ownership_error","message":"file does not belong to this account"}}`)
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r1", "first"), ownership, bpsTextReply("r2", "second"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"prompt_cache_key":"thread-2","input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,` + bpsTestPNG + `"}]}]}`
	if response, body := runBody(t, cfg, httpServer.URL, request, bpsOn); response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	// 第二次复用缓存的附件 ID 被判归属失败：作废缓存、重新上传并重发一次
	response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "second") || upstream.uploads != 2 || len(upstream.responses) != 3 {
		t.Fatalf("status=%d uploads=%d responses=%d body=%s", response.StatusCode, upstream.uploads, len(upstream.responses), body)
	}
}

func TestBPSStructuredOutputIsValidatedLocally(t *testing.T) {
	message := map[string]any{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": `{"city":"Tokyo"}`, "annotations": []any{}}}}
	reply := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "m", "delta": `{"city":"Tokyo"}`})+
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": message})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{message}}}))
	}
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {reply}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"text":{"format":{"type":"json_schema","name":"place","strict":true,"schema":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}},"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"where?"}]}]}`
	response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "response.completed") || !strings.Contains(string(body), `\"city\":\"Tokyo\"`) {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if sent := string(upstream.bodies["bps_tok_a"]); strings.Contains(sent, `"text":{"format"`) || !strings.Contains(sent, "city") {
		t.Fatalf("schema must travel as developer instructions: %s", sent)
	}
}

func TestBPSCarriesTheCompactionTrigger(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "summary")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"long history"}]},{"type":"compaction_trigger"}]}`
	if response, body := runBody(t, cfg, httpServer.URL, request, bpsOn); response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	var sent struct {
		Input []map[string]any `json:"input"`
	}
	if err := json.Unmarshal(upstream.bodies["bps_tok_a"], &sent); err != nil || len(sent.Input) == 0 || sent.Input[len(sent.Input)-1]["type"] != "compaction_trigger" {
		t.Fatalf("compaction trigger must stay last: %s", upstream.bodies["bps_tok_a"])
	}
}

func TestBPSStateSurvivesRestartWithCompareAndSwap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bps_state")
	state := newBPSDiskState(path, nil)
	ctx := context.Background()
	if ok, err := state.SaveBPSState(ctx, "scope", "catalog", bpsVersion(0), []byte("v1")); !ok || err != nil {
		t.Fatalf("first save ok=%v err=%v", ok, err)
	}
	if ok, _ := state.SaveBPSState(ctx, "scope", "catalog", bpsVersion(0), []byte("stale")); ok {
		t.Fatal("stale catalog version must not overwrite")
	}
	if _, err := state.SaveBPSState(ctx, "scope", "big", nil, make([]byte, basispoints.MaxStateEntryBytes+1)); !errors.Is(err, basispoints.ErrStateCapacity) {
		t.Fatalf("oversized entry err=%v", err)
	}
	if err := state.Flush(); err != nil {
		t.Fatal(err)
	}
	reopened := newBPSDiskState(path, nil)
	data, version, err := reopened.LoadBPSState(ctx, "scope", "catalog")
	if err != nil || string(data) != "v1" || version != 1 {
		t.Fatalf("reloaded data=%q version=%d err=%v", data, version, err)
	}
	if data, _, _ := reopened.LoadBPSState(ctx, "other", "catalog"); data != nil {
		t.Fatal("scopes must not share state")
	}
	reopened.now = func() time.Time { return time.Now().Add(3 * time.Hour) }
	if data, _, _ := reopened.LoadBPSState(ctx, "scope", "catalog"); data != nil {
		t.Fatal("idle entries expire after two hours")
	}
}

func bpsVersion(value uint64) *uint64 { return &value }

// 落盘只写有变动的条目：未变动的条目文件不重写，移除的条目删除文件，只读续期只更新修改时间并在重启后生效
func TestBPSStateFlushWritesOnlyChangedEntries(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bps_state")
	state := newBPSDiskState(dir, nil)
	ctx := context.Background()
	for _, name := range []string{"a", "b"} {
		if ok, err := state.SaveBPSState(ctx, "scope", name, nil, []byte(name)); !ok || err != nil {
			t.Fatalf("save %s ok=%v err=%v", name, ok, err)
		}
	}
	if err := state.Flush(); err != nil {
		t.Fatal(err)
	}
	fileA, fileB := state.fileFor(bpsStateKey("scope", "a")), state.fileFor(bpsStateKey("scope", "b"))
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(fileB, old, old); err != nil {
		t.Fatal(err)
	}
	if ok, err := state.SaveBPSState(ctx, "scope", "a", nil, []byte("a2")); !ok || err != nil {
		t.Fatalf("update ok=%v err=%v", ok, err)
	}
	if err := state.Flush(); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(fileB); err != nil || !info.ModTime().Equal(old) {
		t.Fatalf("unchanged entry must not be rewritten: %v %v", info, err)
	}
	if data, _ := os.ReadFile(fileA); !bytes.Contains(data, []byte(base64.StdEncoding.EncodeToString([]byte("a2")))) {
		t.Fatalf("changed entry must be rewritten: %s", data)
	}

	// 只读续期：记录里的过期时间不变，修改时间更新，重启后按修改时间续期
	state.now = func() time.Time { return time.Now().Add(90 * time.Minute) }
	if data, _, _ := state.LoadBPSState(ctx, "scope", "b"); string(data) != "b" {
		t.Fatalf("load b = %q", data)
	}
	if err := state.Flush(); err != nil {
		t.Fatal(err)
	}
	reopened := newBPSDiskState(dir, nil)
	reopened.now = func() time.Time { return time.Now().Add(150 * time.Minute) }
	if data, _, _ := reopened.LoadBPSState(ctx, "scope", "b"); string(data) != "b" {
		t.Fatalf("renewed entry must survive restart past its first expiry, got %q", data)
	}
	if data, _, _ := reopened.LoadBPSState(ctx, "scope", "a"); data != nil {
		t.Fatalf("entry not renewed must expire, got %q", data)
	}
	if err := reopened.Flush(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(fileA); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired entry file must be deleted: %v", err)
	}
}

// 早期单文件 bps_state.json 迁入按条目存储后删除；加密配置下条目文件不含明文，无法解密的文件丢弃
func TestBPSStateImportsLegacyFileEncrypted(t *testing.T) {
	root := t.TempDir()
	store := &Store{sealKey: bytes.Repeat([]byte{7}, 32)}
	legacy := map[string]*bpsDiskEntry{
		bpsStateKey("scope", "catalog"): {Data: []byte("secret catalog"), Version: 3, Expires: time.Now().Add(time.Hour)},
		bpsStateKey("scope", "stale"):   {Data: []byte("x"), Version: 1, Expires: time.Now().Add(-time.Minute)},
	}
	plain, _ := json.Marshal(legacy)
	sealed, err := store.seal(plain)
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(root, "bps_state.json")
	if err := os.WriteFile(legacyPath, sealed, 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "bps_state")
	state := newBPSDiskState(dir, store)
	if err := state.importLegacy(legacyPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("legacy file must be removed: %v", err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatalf("only the live entry is migrated, got %d files", len(files))
	}
	raw, _ := os.ReadFile(filepath.Join(dir, files[0].Name()))
	if bytes.Contains(raw, []byte("secret")) || !bytes.HasPrefix(raw, []byte(accountStoreSealPrefix)) {
		t.Fatalf("entry file must be sealed: %s", raw)
	}
	data, version, _ := newBPSDiskState(dir, store).LoadBPSState(context.Background(), "scope", "catalog")
	if string(data) != "secret catalog" || version != 3 {
		t.Fatalf("migrated entry data=%q version=%d", data, version)
	}
	if data, _, _ := newBPSDiskState(dir, &Store{sealKey: bytes.Repeat([]byte{9}, 32)}).LoadBPSState(context.Background(), "scope", "catalog"); data != nil {
		t.Fatal("entries sealed with another key must be dropped")
	}
	if files, _ := os.ReadDir(dir); len(files) != 0 {
		t.Fatalf("undecryptable entry files must be deleted, got %d", len(files))
	}
}

func allowLocalBPSImages(t *testing.T) {
	t.Helper()
	previous := bpsImageHostAllowed
	bpsImageHostAllowed = func(string) bool { return true }
	t.Cleanup(func() { bpsImageHostAllowed = previous })
}

func TestBPSDownloadsRemoteImagesAndUploadsThemAsAttachments(t *testing.T) {
	allowLocalBPSImages(t)
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"` + server.URL + `/moved"},{"type":"input_image","image_url":"` + server.URL + `/moved"}]}]}`
	response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
	if response.StatusCode != 200 || response.Header.Get(authModeHeader) != "bps" {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	sent := string(upstream.responses[0])
	if upstream.uploads != 1 || !strings.Contains(sent, `"file_id":"file-up1"`) || strings.Contains(sent, server.URL) {
		t.Fatalf("remote images must be downloaded once and sent as attachments: uploads=%d body=%s", upstream.uploads, sent)
	}
}

func TestBPSRemoteImageFailureEndsTheRequest(t *testing.T) {
	allowLocalBPSImages(t)
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	for _, link := range []string{server.URL + "/page.html", server.URL + "/missing"} {
		request := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"` + link + `"}]}]}`
		response, body := runBody(t, cfg, httpServer.URL, request, bpsOn)
		if response.StatusCode != 400 || !strings.Contains(string(body), "invalid_image_url") || response.Header.Get(sendStateHeader) != sendStateNotSent {
			t.Fatalf("%s: status=%d body=%s", link, response.StatusCode, body)
		}
	}
	if upstream.uploads != 0 || len(upstream.responses) != 0 {
		t.Fatalf("nothing may reach BPS: uploads=%d responses=%d", upstream.uploads, len(upstream.responses))
	}
}

func TestBPSRemoteImagesRefuseLocalHosts(t *testing.T) {
	for host, allowed := range map[string]bool{"127.0.0.1": false, "localhost": false, "10.1.2.3": false, "192.168.1.1": false, "169.254.169.254": false, "::1": false, "images.example.com": true, "8.8.8.8": true} {
		if bpsImageHostAllowed(host) != allowed {
			t.Fatalf("%s allowed=%v", host, !allowed)
		}
	}
}

func TestBPSProbeIsRecordedForTheControlPlane(t *testing.T) {
	message := map[string]any{"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "pong", "annotations": []any{}}}}
	reply := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{message}, "usage": map[string]any{"input_tokens": 12, "output_tokens": 3, "total_tokens": 15}}}))
	}
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {jsonReply(403, `{"error":{"code":"account_deactivated"}}`), reply}})
	acct := bpsAccount("a", "tok_a")
	acct.BPSSettings.AutoRecoverOn403 = true
	acct.BPS.State, acct.BPS.BlockedAt = bpsStateBlocked, time.Now().Add(-2*time.Hour)
	gw, _, _ := newBPSExecuteServer(t, server.URL, acct)
	gw.probeBlockedBPS(context.Background(), time.Now())
	gw.probeBlockedBPS(context.Background(), time.Now().Add(2*time.Hour))
	probes := gw.pendingBPSProbes()
	if len(probes) != 2 || probes[0].OK || probes[0].Status != 403 || probes[0].ErrorCode != "account_deactivated" || !probes[1].OK || probes[1].TotalTokens != 15 || probes[1].Model != "gpt-test" {
		t.Fatalf("probes=%+v", probes)
	}
	gw.commitBPSProbes(probes[:1])
	if left := gw.pendingBPSProbes(); len(left) != 1 || !left[0].OK {
		t.Fatalf("only reported probes are removed: %+v", left)
	}
}

func TestBPSPolicyRefusalsAreNotReplayed(t *testing.T) {
	for code, want := range map[string]string{"cyber_policy": "cyber_policy", "content_policy_violation": "content_policy_violation"} {
		upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
			"bps_tok_a": {jsonReply(403, `{"error":{"type":"invalid_request_error","code":"`+code+`","message":"blocked"}}`)},
			"bps_tok_b": {bpsTextReply("r", "other")},
			"tok_a":     {nativeReply("native")},
		})
		first := bpsAccount("a", "tok_a")
		first.Weight = 5
		_, httpServer, cfg := newBPSExecuteServer(t, server.URL, first, bpsAccount("b", "tok_b"))
		response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
		if response.StatusCode != 400 || !strings.Contains(string(body), want) || upstream.count("bps_tok_b") != 0 || upstream.count("tok_a") != 0 {
			t.Fatalf("%s: status=%d body=%s calls=%v", code, response.StatusCode, body, upstream.sequence)
		}
	}
}

func TestBPSServerErrorRotatesInsteadOfFailing(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {jsonReply(502, `{"error":{"type":"server_error","code":"bad_gateway"}}`)},
		"tok_a":     {nativeReply("native")},
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	// 5xx 先同号重试一次（对齐 sub2api），仍失败再离开 BPS 改走原生
	if response.StatusCode != 200 || upstream.count("bps_tok_a") != 2 || upstream.count("tok_a") != 1 {
		t.Fatalf("status=%d body=%s seq=%v", response.StatusCode, body, upstream.sequence)
	}
}

func TestBPSUnauthorizedIsHiddenFromTheCaller(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {jsonReply(403, `{"error":{"code":"forbidden","message":"no"}}`)}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	// Key 级“只走 BPS”：BPS 拒绝后不转原生，交付 BPS 的失败；401/403 对调用方投影为 503
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyBPSOnly})
	if response.StatusCode != 503 || !strings.Contains(string(body), "basispoints_upstream_error") || upstream.count("tok_a") != 0 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}

func TestBPSStreamIdleTimeoutEndsTheStream(t *testing.T) {
	stall := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r", "output": []any{}}}))
		w.(http.Flusher).Flush()
		time.Sleep(3 * time.Second)
	}
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {stall}})
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", UpstreamBaseURL: server.URL, BPSBaseURL: server.URL + "/bps", UpstreamTransport: "http", RequestTimeoutSec: 10, BPSStreamIdleSec: 1}
	cfg.applyDefaults()
	gw, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = gw.store.Upsert(bpsAccount("a", "tok_a"))
	httpServer := httptest.NewServer(gw.Handler())
	defer httpServer.Close()
	started := time.Now()
	response, _ := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Fatalf("stalled BPS stream was not cut by the idle timeout: %v status=%d", elapsed, response.StatusCode)
	}
}

func bpsReasoningReply(id, cipher, text string) func(http.ResponseWriter) {
	reasoning := map[string]any{"type": "reasoning", "id": "rs_" + id, "summary": []any{}, "encrypted_content": cipher}
	message := map[string]any{"type": "message", "id": "m_" + id, "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": id, "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": reasoning})+
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 1, "content_index": 0, "item_id": "m_" + id, "delta": text})+
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 1, "item": message})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": id, "status": "completed", "output": []any{reasoning, message}}}))
	}
}

func historyRequest(cipher string) string {
	return `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},{"type":"reasoning","summary":[],"encrypted_content":"` + cipher + `"},{"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}]}`
}

// 对齐 sub2api：历史来源不锁定通道。BPS 产生的历史在 BPS 不可用时改走原生；原生读不了 BPS 的密文时，
// 在同一原生账号缩减后重发（生产 11-05：BPS 账号凭据失效后，锁定在 BPS 的会话持续 503 codex_route_history_pinned）。
func TestBPSProducedHistorySwitchesToNative(t *testing.T) {
	limited := jsonReply(429, `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}`, "Retry-After", "30")
	rejected := jsonReply(400, `{"error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"The encrypted content for item rs_r1 could not be verified."}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {bpsReasoningReply("r1", "BPS-CIPHER", "first"), limited},
		"tok_a":     {rejected, nativeReply("native")},
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	if response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn); response.StatusCode != 200 {
		t.Fatalf("first turn status=%d body=%s", response.StatusCode, body)
	}
	response, body := runBody(t, cfg, httpServer.URL, historyRequest("BPS-CIPHER"), bpsOn)
	if response.StatusCode != 200 || !strings.Contains(string(body), "native") || upstream.count("tok_a") != 2 {
		t.Fatalf("BPS history must switch to native: status=%d body=%s seq=%v", response.StatusCode, body, upstream.sequence)
	}
	decoder, _ := zstd.NewReader(nil)
	defer decoder.Close()
	native := upstream.bodies["tok_a"]
	if decoded, err := decoder.DecodeAll(native, nil); err == nil {
		native = decoded
	}
	if strings.Contains(string(native), "BPS-CIPHER") || !strings.Contains(string(native), "again") {
		t.Fatalf("native retry must drop the BPS ciphertext and keep the messages: %s", native)
	}
}

func TestNativeHistorySwitchesToBPS(t *testing.T) {
	nativeWithCipher := sseReply(`{"type":"response.created","response":{"id":"n1"}}`, `{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_n","summary":[],"encrypted_content":"NATIVE-CIPHER"}}`, `{"type":"response.completed","response":{"id":"n1","output":[{"type":"reasoning","summary":[],"encrypted_content":"NATIVE-CIPHER"}]}}`)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {bpsTextReply("b", "bps")},
		"tok_a":     {nativeWithCipher, nativeReply("native")},
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	if response, _ := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{}); response.StatusCode != 200 {
		t.Fatalf("native first turn status=%d", response.StatusCode)
	}
	response, body := runBody(t, cfg, httpServer.URL, historyRequest("NATIVE-CIPHER"), bpsOn)
	if response.StatusCode != 200 || upstream.count("bps_tok_a") != 1 || upstream.count("tok_a") != 1 {
		t.Fatalf("native history must be able to use BPS: status=%d body=%s seq=%v", response.StatusCode, body, upstream.sequence)
	}
}

func TestMixedAndUnknownHistoryAreServed(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("b", "bps")}})
	gw, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	gw.provenance.recordOwned("", routeNative, "a", []string{encryptedKey("N")})
	body := `{"model":"gpt-test","stream":true,"input":[{"type":"reasoning","summary":[],"encrypted_content":"B"},{"type":"reasoning","summary":[],"encrypted_content":"N"}]}`
	if response, data := runBody(t, cfg, httpServer.URL, body, bpsOn); response.StatusCode != 200 || upstream.count("bps_tok_a") != 1 {
		t.Fatalf("status=%d body=%s", response.StatusCode, data)
	}
	// 签发记录跨重启保留
	if err := gw.provenance.Flush(); err != nil {
		t.Fatal(err)
	}
	reopened := newRouteProvenance(gw.provenance.path, gw.store)
	if owner := reopened.owner("", []string{encryptedKey("N")}); owner != "a" {
		t.Fatalf("history owner not persisted: %q", owner)
	}
}

func TestUnknownOpaqueHistorySwitchesToNativeAfterBPS(t *testing.T) {
	limited := jsonReply(429, `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}`, "Retry-After", "30")
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {limited}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, historyRequest("UNKNOWN"), bpsOn)
	if response.StatusCode != 200 || upstream.count("tok_a") != 1 {
		t.Fatalf("status=%d body=%s seq=%v", response.StatusCode, body, upstream.sequence)
	}
}

func TestBPSSkipsGenerateFalseWarmups(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "bps")}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	body := `{"model":"gpt-test","stream":true,"generate":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`
	if response, data := runBody(t, cfg, httpServer.URL, body, bpsOn); response.StatusCode != 200 || upstream.count("bps_tok_a") != 0 {
		t.Fatalf("warmup reached BPS: status=%d body=%s", response.StatusCode, data)
	}
}

// 没有会话标识的请求用请求内临时身份：不继承其他请求声明的工具；有会话标识时同一会话照常复用目录
func TestBPSRequestsWithoutASessionDoNotShareTheToolCatalog(t *testing.T) {
	withTools := `{"model":"gpt-test","stream":true,"tools":[{"type":"function","name":"secret_tool","parameters":{"type":"object","properties":{}}}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}`
	withoutTools := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}]}`
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "ok")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	runBody(t, cfg, httpServer.URL, withTools, bpsOn)
	runBody(t, cfg, httpServer.URL, withoutTools, bpsOn)
	if strings.Contains(string(upstream.bodies["bps_tok_a"]), "secret_tool") {
		t.Fatal("a request without a session inherited another request's tools")
	}
	sessioned := func(body string) string {
		return strings.Replace(body, `"stream":true`, `"stream":true,"prompt_cache_key":"conv-1"`, 1)
	}
	runBody(t, cfg, httpServer.URL, sessioned(withTools), bpsOn)
	runBody(t, cfg, httpServer.URL, sessioned(withoutTools), bpsOn)
	if !strings.Contains(string(upstream.bodies["bps_tok_a"]), "secret_tool") {
		t.Fatal("the same session must keep its tool catalog")
	}
}

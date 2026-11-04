package codexgateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
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
		"image":        `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}]}`,
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

func TestBPSOAuthAddsTheGrantToAnExistingOAuthAccount(t *testing.T) {
	idToken := func(accountID, plan string) string {
		return jwtFixture(map[string]any{"aud": []any{"app_fnr0pYvVwwFDocDumLG3H2Bp"}, "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": accountID, "chatgpt_plan_type": plan}})
	}
	var form url.Values
	identity := idToken("chatgpt-a", "pro")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.Form
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": jwtFixture(map[string]any{"client_id": "app_fnr0pYvVwwFDocDumLG3H2Bp"}), "refresh_token": "bps-refresh", "id_token": identity, "expires_in": 3600})
	}))
	defer provider.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: provider.URL}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.oauthStartRequest(map[string]any{"runtime_account_id": "missing", "grant": "bps"}); err == nil {
		t.Fatal("BPS authorization must require an existing OAuth account")
	}
	native := account("a", "tok_a")
	native.ChatGPTAccountID = "chatgpt-a"
	native.CredentialRevision = 3
	_, _ = server.store.Upsert(native)
	complete := func() error {
		started, err := server.oauthStartRequest(map[string]any{"draft_id": "d", "runtime_account_id": "a", "grant": "bps"})
		if err != nil {
			return err
		}
		authURL, _ := url.Parse(started["auth_url"].(string))
		if authURL.Path != "/api/accounts/authorize" || authURL.Query().Get("client_id") != cfg.BPSClientID || started["flavor"] != "bps" {
			t.Fatalf("auth url=%s", authURL)
		}
		session := server.oauthSessions[started["session_id"].(string)]
		_, err = server.oauthCompleteRequest(map[string]any{"session_id": session.SessionID, "draft_id": "d", "callback": cfg.BPSRedirectURI + "?code=c&state=" + session.State})
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
	identity = idToken("chatgpt-other", "pro")
	if err := complete(); err == nil || !strings.Contains(err.Error(), "different ChatGPT account") {
		t.Fatalf("identity mismatch err=%v", err)
	}
	identity = idToken("chatgpt-a", "free")
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
	foreign := jwtFixture(map[string]any{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"})
	if status, body := call("POST", "/internal/v1/accounts/a/bps/import", `{"access_token":"`+foreign+`","refresh_token":"r"}`); status != 400 {
		t.Fatalf("foreign client import status=%d body=%s", status, body)
	}
	excel := jwtFixture(map[string]any{"client_id": cfg.BPSClientID, "exp": time.Now().Add(time.Minute).Unix()})
	if status, body := call("POST", "/internal/v1/accounts/a/bps/import", `{"access_token":"`+excel+`","refresh_token":"bps_rt"}`); status != 200 || strings.Contains(body, "bps_rt") {
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

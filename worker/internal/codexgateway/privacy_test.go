package codexgateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

func privacyRule(id string, steps ...PrivacyStep) PrivacyRule {
	return PrivacyRule{ID: id, Name: id, Enabled: true, Steps: steps}
}

func previewBody(t *testing.T, policy PrivacyPolicy, body string, headers map[string][]string) (*privacyPreviewResult, error) {
	t.Helper()
	return previewPrivacy(PrivacyPreviewRequest{Policy: policy, Body: json.RawMessage(body), Headers: headers})
}

func TestPrivacyRegexRemoveSetAndRenameKeepOrder(t *testing.T) {
	policy := PrivacyPolicy{Enabled: true, OnError: "skip_rule", Rules: []PrivacyRule{
		privacyRule("email", PrivacyStep{Scope: "request_body", Selector: "$.input[*].content[*].text", Action: "regex_replace", Pattern: ptr(`(?P<user>[a-z]+)@example\.com`), Replacement: "${user}@redacted", ReplaceAll: true}),
		privacyRule("drop", PrivacyStep{Scope: "request_body", Selector: "$.metadata.*", Action: "remove_field", Pattern: ptr("^secret")}),
		privacyRule("rename", PrivacyStep{Scope: "request_body", Selector: "$.metadata", Action: "rename_key", Pattern: ptr("^user_"), Replacement: "u_"}),
		privacyRule("tier", PrivacyStep{Scope: "request_body", Selector: "$.store", Action: "set_value", Value: json.RawMessage("false")}),
	}}
	body := `{"model":"m","input":[{"role":"user","content":[{"type":"input_text","text":"a@example.com, bob@example.com <x>"}]}],"metadata":{"user_id":"1","token":"secret-1","keep":"ok"},"store":true}`
	result, err := previewBody(t, policy, body, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"model":"m","input":[{"role":"user","content":[{"type":"input_text","text":"a@redacted, bob@redacted <x>"}]}],"metadata":{"u_id":"1","keep":"ok"},"store":false}`
	if string(result.Body) != want {
		t.Fatalf("body=%s", result.Body)
	}
	for i, status := range []string{"applied", "applied", "applied", "applied"} {
		if result.Outcomes[i].Status != status {
			t.Fatalf("outcomes=%+v", result.Outcomes)
		}
	}
	if result.Outcomes[0].Matches != 2 {
		t.Fatalf("matches=%+v", result.Outcomes[0])
	}
}

func TestPrivacyRuleTransactionRollsBackAndRejects(t *testing.T) {
	steps := []PrivacyStep{
		{Scope: "request_body", Selector: "$.a", Action: "regex_replace", Pattern: ptr("x"), Replacement: "y"},
		{Scope: "request_body", Selector: "$.n", Action: "set_value", Value: json.RawMessage(`"text"`)},
	}
	policy := PrivacyPolicy{Enabled: true, OnError: "skip_rule", Rules: []PrivacyRule{privacyRule("r1", steps...)}}
	result, err := previewBody(t, policy, `{"a":"x","n":1}`, nil)
	if err != nil || string(result.Body) != `{"a":"x","n":1}` || result.Outcomes[0].Status != "skipped" || result.Outcomes[0].Reason != "固定值必须保持原字段类型" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	policy.OnError = "reject_request"
	if _, err := previewBody(t, policy, `{"a":"x","n":1}`, nil); err == nil || !strings.Contains(err.Error(), "privacy rule 1") {
		t.Fatalf("reject err=%v", err)
	}
	policy.Enabled = false
	result, _ = previewBody(t, policy, `{"a":"x","n":1}`, nil)
	if result.Outcomes[0].Status != "disabled" {
		t.Fatalf("disabled outcome=%+v", result.Outcomes)
	}
}

func TestPrivacyCompileLimits(t *testing.T) {
	cases := map[string]PrivacyPolicy{
		"捕获组":   {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_body", Selector: "$.a", Action: "regex_replace", Pattern: ptr("(x)"), Replacement: "$2"})}},
		"前后顾":   {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_body", Selector: "$.a", Action: "regex_replace", Pattern: ptr("(?=x)"), Replacement: ""})}},
		"过滤表达式": {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_body", Selector: "$.a[?(@.x)]", Action: "remove_field"})}},
		"请求头":   {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_header", Selector: "bad header", Action: "remove_field"})}},
		"重复 ID": {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_body", Selector: "$.a", Action: "remove_field"}), privacyRule("a", PrivacyStep{Scope: "request_body", Selector: "$.b", Action: "remove_field"})}},
		"环境路径":  {Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "environment_text", Selector: "$.a", Action: "remove_field"})}},
	}
	for name, policy := range cases {
		if _, err := compilePrivacy(&policy); err == nil {
			t.Fatalf("%s: compile should fail", name)
		}
	}
	deep := "$" + strings.Repeat(".a", 17)
	if _, err := compilePrivacy(&PrivacyPolicy{Rules: []PrivacyRule{privacyRule("a", PrivacyStep{Scope: "request_body", Selector: deep, Action: "remove_field"})}}); err == nil {
		t.Fatal("17-level path accepted")
	}
}

func TestPrivacyHeadersAndTurnMetadataCarriers(t *testing.T) {
	policy := PrivacyPolicy{Enabled: true, Rules: []PrivacyRule{
		privacyRule("meta", PrivacyStep{Scope: "turn_metadata", Selector: "$.workspace", Action: "remove_field"}),
		privacyRule("ua", PrivacyStep{Scope: "request_header", Selector: "x-client-name", Action: "regex_replace", Pattern: ptr("laptop-[0-9]+"), Replacement: "host"}),
	}}
	body := `{"client_metadata":{"x-codex-turn-metadata":"{\"workspace\":\"/home/me\",\"turn\":1}"},"turn_metadata":{"workspace":"w","k":1}}`
	result, err := previewBody(t, policy, body, map[string][]string{"x-codex-turn-metadata": {`{"workspace":"/srv","b":"\u4e2d"}`}, "x-client-name": {"laptop-42"}})
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Body) != `{"client_metadata":{"x-codex-turn-metadata":"{\"turn\":1}"},"turn_metadata":{"k":1}}` {
		t.Fatalf("body=%s", result.Body)
	}
	if result.Headers["x-codex-turn-metadata"][0] != `{"b":"\u4e2d"}` || result.Headers["x-client-name"][0] != "host" {
		t.Fatalf("headers=%v", result.Headers)
	}
	nonASCII := PrivacyPolicy{Enabled: true, OnError: "reject_request", Rules: []PrivacyRule{privacyRule("h", PrivacyStep{Scope: "request_header", Selector: "x-a", Action: "regex_replace", Pattern: ptr("a"), Replacement: "中"})}}
	if _, err := previewBody(t, nonASCII, `{}`, map[string][]string{"x-a": {"a"}}); err == nil {
		t.Fatal("non-ASCII header value accepted")
	}
}

func TestPrivacyDesktopGitAndEnvironmentContexts(t *testing.T) {
	text := `<external_codex_git_state><environment_context><git source="a>b" trust="untrusted">{"workspaces":{"/private":{}},"note":"a &amp; b"}</git></environment_context></external_codex_git_state>`
	body, _ := json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "input_text", "text": text}, map[string]any{"type": "input_text", "text": text},
	}, "internal_chat_message_metadata_passthrough": map[string]any{"content_item_kinds": []any{"additional_content.codex_git_state", "user.text"}}}}})
	policy := PrivacyPolicy{Enabled: true, Rules: []PrivacyRule{privacyRule("git", PrivacyStep{Scope: "desktop_git_context", Selector: "$.workspaces", Action: "remove_field"})}}
	result, err := previewBody(t, policy, string(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Input []struct {
			Content []struct{ Text string } `json:"content"`
		} `json:"input"`
	}
	_ = json.Unmarshal(result.Body, &out)
	first, second := out.Input[0].Content[0].Text, out.Input[0].Content[1].Text
	if first != `<external_codex_git_state><environment_context><git source="a>b" trust="untrusted">{"note":"a &amp; b"}</git></environment_context></external_codex_git_state>` || second != text {
		t.Fatalf("first=%s second=%s", first, second)
	}
	cdata := `<external_codex_git_state><environment_context><git><![CDATA[{"workspaces":{},"note":"a & b"}]]></git></environment_context></external_codex_git_state>`
	body, _ = json.Marshal(map[string]any{"input": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": cdata}}}}})
	result, err = previewBody(t, policy, string(body), nil)
	if err != nil || !strings.Contains(string(result.Body), `{\"note\":\"a &amp; b\"}`) {
		t.Fatalf("cdata body=%s err=%v", result.Body, err)
	}

	env := PrivacyPolicy{Enabled: true, Rules: []PrivacyRule{privacyRule("tz", PrivacyStep{Scope: "environment_text", Selector: "$", Action: "regex_replace", Pattern: ptr("Asia/Shanghai"), Replacement: "UTC"})}}
	body, _ = json.Marshal(map[string]any{"input": []any{map[string]any{"role": "developer", "content": []any{map[string]any{"type": "input_text", "text": "<codex_apps_client_time_context><timezone>Asia/Shanghai</timezone></codex_apps_client_time_context>"}}}}})
	result, err = previewBody(t, env, string(body), nil)
	if err != nil || !strings.Contains(string(result.Body), "<timezone>UTC</timezone>") {
		t.Fatalf("env body=%s err=%v", result.Body, err)
	}
	shape := PrivacyPolicy{Enabled: true, Rules: []PrivacyRule{privacyRule("tag", PrivacyStep{Scope: "environment_text", Selector: "$", Action: "regex_replace", Pattern: ptr("timezone"), Replacement: "tz", ReplaceAll: true})}}
	result, _ = previewBody(t, shape, string(body), nil)
	if result.Outcomes[0].Status != "skipped" || result.Outcomes[0].Reason != "替换不能改变环境上下文包裹结构" {
		t.Fatalf("shape outcome=%+v", result.Outcomes)
	}
}

func TestExecuteAppliesPrivacyAndRejects(t *testing.T) {
	var got http.Header
	var body []byte
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		got = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		body = decompressed(r, raw)
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "acct_1", Enabled: true, AccessToken: "tok", Groups: []string{"1"}})
	policy := &PrivacyPolicy{Enabled: true, Rules: []PrivacyRule{
		privacyRule("body", PrivacyStep{Scope: "request_body", Selector: "$.instructions", Action: "regex_replace", Pattern: ptr("/Users/[a-z]+"), Replacement: "~"}),
		privacyRule("ua", PrivacyStep{Scope: "request_header", Selector: "version", Action: "set_value", Value: json.RawMessage(`"0.0.1"`)}),
	}}
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_privacy", RequestID: "r_privacy", Nonce: "privacy", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","instructions":"cwd /Users/alice/x"}`), Scope: Scope{GroupIDs: []int64{1}}, Privacy: policy})
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"instructions":"cwd ~/x"`) || got.Get("version") != "0.0.1" {
		t.Fatalf("status=%d body=%s version=%q", response.StatusCode, body, got.Get("version"))
	}
	reject := &PrivacyPolicy{Enabled: true, OnError: "reject_request", Rules: []PrivacyRule{privacyRule("bad", PrivacyStep{Scope: "request_body", Selector: "$.instructions", Action: "set_value", Value: json.RawMessage(`1`)})}}
	response = signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_privacy2", RequestID: "r_privacy2", Nonce: "privacy2", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","instructions":"x"}`), Scope: Scope{GroupIDs: []int64{1}}, Privacy: reject})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "privacy_policy_rejected") || response.Header.Get(sendStateHeader) != sendStateNotSent || calls != 1 {
		t.Fatalf("status=%d body=%s calls=%d", response.StatusCode, data, calls)
	}
	// 心跳下发的通用策略在信封未携带时生效
	server.privacy.observe(policy)
	compiled, _ := server.privacy.forRequest(nil)
	out, err := compiled.applyBody(context.Background(), []byte(`{"instructions":"/Users/bob"}`), http.Header{})
	if err != nil || string(out) != `{"instructions":"~"}` {
		t.Fatalf("global policy out=%s err=%v", out, err)
	}
}

package codexgateway

import "testing"

func TestNormalizeCodexOAuthBodyReasoningAndSearchHistory(t *testing.T) {
	cases := []struct {
		name, in, want string
		lite           bool
	}{
		{"reasoning cleanup",
			`{"model":"m","store":false,"input":[{"type":"reasoning","id":"rs_1","status":"completed","summary":[],"content":[{"type":"reasoning_text","text":"t"}],"encrypted_content":"enc"},{"type":"reasoning","content":[{"type":"reasoning_text","text":"keep"}]}]}`,
			`{"model":"m","store":false,"input":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc"},{"type":"reasoning","content":[{"type":"reasoning_text","text":"keep"}]}]}`, false},
		{"append search tool and keep choice",
			`{"store":false,"input":[{"type":"web_search_call","id":"ws_1"}],"tools":[{"type":"function","name":"f"}],"tool_choice":"required"}`,
			`{"store":false,"input":[{"type":"web_search_call","id":"ws_1"}],"tools":[{"type":"function","name":"f"},{"type":"web_search","external_web_access":false}],"tool_choice":"required"}`, false},
		{"no tools disables new calls",
			`{"store":false,"input":[{"type":"web_search_call"}]}`,
			`{"store":false,"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search","external_web_access":false}],"tool_choice":"none"}`, false},
		{"forced choice without tools is left to upstream",
			`{"store":false,"input":[{"type":"web_search_call"}],"tool_choice":"required"}`,
			`{"store":false,"input":[{"type":"web_search_call"}],"tool_choice":"required"}`, false},
		{"lite inserts before compaction trigger",
			`{"store":false,"input":[{"type":"web_search_call"},{"type":"compaction_trigger"}]}`,
			`{"store":false,"input":[{"type":"web_search_call"},{"type":"additional_tools","role":"developer","tools":[{"type":"web_search","external_web_access":false}]},{"type":"compaction_trigger"}],"tool_choice":"none"}`, true},
		{"continuation untouched",
			`{"store":false,"previous_response_id":"resp_1","input":[{"type":"web_search_call"}]}`,
			`{"store":false,"previous_response_id":"resp_1","input":[{"type":"web_search_call"}]}`, false},
		{"declared preview untouched",
			`{"store":false,"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search_preview_2025_03_11"}]}`,
			`{"store":false,"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search_preview_2025_03_11"}]}`, false},
		{"lite declaration in history untouched",
			`{"store":false,"input":[{"type":"additional_tools","tools":[{"type":"web_search"}]},{"type":"web_search_call"}]}`,
			`{"store":false,"input":[{"type":"additional_tools","tools":[{"type":"web_search"}]},{"type":"web_search_call"}]}`, true},
	}
	for _, tc := range cases {
		if got := string(normalizeCodexOAuthBody([]byte(tc.in), tc.lite)); got != tc.want {
			t.Fatalf("%s:\n got  %s\n want %s", tc.name, got, tc.want)
		}
	}
	plain := `{"model":"m","store":false,"input":"hi"}`
	if got := string(normalizeCodexOAuthBody([]byte(plain), false)); got != plain {
		t.Fatalf("unrelated body changed: %s", got)
	}
}

// 缺少 store 时补 false（CPR normalize_codex_request_body）；显式值（包括 true 与 null）保留，嵌套对象里的同名字段不算
func TestNormalizeCodexOAuthBodyDefaultsStore(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"model":"m","input":"hi"}`, `{"model":"m","input":"hi","store":false}`},
		{`{"model":"m","store":true}`, `{"model":"m","store":true}`},
		{`{"model":"m","metadata":{"store":true}}`, `{"model":"m","metadata":{"store":true},"store":false}`},
		{`not json`, `not json`},
	}
	for _, tc := range cases {
		if got := string(normalizeCodexOAuthBody([]byte(tc.in), false)); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}

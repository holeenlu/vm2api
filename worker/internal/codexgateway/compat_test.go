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
		{`{"model":"m","client_metadata":{"store":true}}`, `{"model":"m","client_metadata":{"store":true},"store":false}`},
		{`not json`, `not json`},
	}
	for _, tc := range cases {
		if got := string(normalizeCodexOAuthBody([]byte(tc.in), false)); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}

// CPR 55526973：Codex OAuth 拒绝的客户端选项被移除；无实际效果的配置省略，有效配置与嵌套同名字段保留；Chat 上限别名只补缺
func TestNormalizeCodexOAuthBodyOptions(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"rejected options removed",
			`{"model":"m","store":false,"top_p":1,"frequency_penalty":0,"presence_penalty":0,"chat_template_kwargs":{"a":1},"user":"u","metadata":{"s":1},"safety_identifier":"x","client_metadata":{"user":"keep"},"tools":[{"type":"function","name":"f","parameters":{"type":"object","properties":{"top_p":{"type":"number"}}}}]}`,
			`{"model":"m","store":false,"client_metadata":{"user":"keep"},"tools":[{"type":"function","name":"f","parameters":{"type":"object","properties":{"top_p":{"type":"number"}}}}]}`},
		{"usage option removed other stream options kept",
			`{"store":false,"stream_options":{"include_usage":true,"reasoning_summary_delivery":"sequential_cutoff"}}`,
			`{"store":false,"stream_options":{"reasoning_summary_delivery":"sequential_cutoff"}}`},
		{"no-op settings omitted",
			`{"store":false,"truncation":"disabled","stop_sequences":[],"prompt_cache_options":{}}`,
			`{"store":false}`},
		{"effective settings kept",
			`{"store":false,"truncation":"auto","stop_sequences":["end"],"prompt_cache_options":{"future_option":true}}`,
			`{"store":false,"truncation":"auto","stop_sequences":["end"],"prompt_cache_options":{"future_option":true}}`},
		{"native limit wins",
			`{"store":false,"max_output_tokens":16,"max_completion_tokens":32,"max_tokens":64}`,
			`{"store":false,"max_output_tokens":16}`},
		{"completion alias fills null native",
			`{"store":false,"max_output_tokens":null,"max_completion_tokens":32,"max_tokens":64}`,
			`{"store":false,"max_output_tokens":32}`},
		{"max_tokens alias fills missing native",
			`{"store":false,"max_completion_tokens":null,"max_tokens":64}`,
			`{"store":false,"max_output_tokens":64}`},
	}
	for _, tc := range cases {
		if got := string(normalizeCodexOAuthBody([]byte(tc.in), false)); got != tc.want {
			t.Fatalf("%s:\n got  %s\n want %s", tc.name, got, tc.want)
		}
	}
}

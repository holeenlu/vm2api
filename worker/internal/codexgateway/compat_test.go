package codexgateway

import "testing"

func TestNormalizeCodexOAuthBodyReasoningAndSearchHistory(t *testing.T) {
	cases := []struct {
		name, in, want string
		lite           bool
	}{
		{"reasoning cleanup",
			`{"model":"m","input":[{"type":"reasoning","id":"rs_1","status":"completed","summary":[],"content":[{"type":"reasoning_text","text":"t"}],"encrypted_content":"enc"},{"type":"reasoning","content":[{"type":"reasoning_text","text":"keep"}]}]}`,
			`{"model":"m","input":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc"},{"type":"reasoning","content":[{"type":"reasoning_text","text":"keep"}]}]}`, false},
		{"append search tool and keep choice",
			`{"input":[{"type":"web_search_call","id":"ws_1"}],"tools":[{"type":"function","name":"f"}],"tool_choice":"required"}`,
			`{"input":[{"type":"web_search_call","id":"ws_1"}],"tools":[{"type":"function","name":"f"},{"type":"web_search","external_web_access":false}],"tool_choice":"required"}`, false},
		{"no tools disables new calls",
			`{"input":[{"type":"web_search_call"}]}`,
			`{"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search","external_web_access":false}],"tool_choice":"none"}`, false},
		{"forced choice without tools is left to upstream",
			`{"input":[{"type":"web_search_call"}],"tool_choice":"required"}`,
			`{"input":[{"type":"web_search_call"}],"tool_choice":"required"}`, false},
		{"lite inserts before compaction trigger",
			`{"input":[{"type":"web_search_call"},{"type":"compaction_trigger"}]}`,
			`{"input":[{"type":"web_search_call"},{"type":"additional_tools","role":"developer","tools":[{"type":"web_search","external_web_access":false}]},{"type":"compaction_trigger"}],"tool_choice":"none"}`, true},
		{"continuation untouched",
			`{"previous_response_id":"resp_1","input":[{"type":"web_search_call"}]}`,
			`{"previous_response_id":"resp_1","input":[{"type":"web_search_call"}]}`, false},
		{"declared preview untouched",
			`{"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search_preview_2025_03_11"}]}`,
			`{"input":[{"type":"web_search_call"}],"tools":[{"type":"web_search_preview_2025_03_11"}]}`, false},
		{"lite declaration in history untouched",
			`{"input":[{"type":"additional_tools","tools":[{"type":"web_search"}]},{"type":"web_search_call"}]}`,
			`{"input":[{"type":"additional_tools","tools":[{"type":"web_search"}]},{"type":"web_search_call"}]}`, true},
	}
	for _, tc := range cases {
		if got := string(normalizeCodexOAuthBody([]byte(tc.in), tc.lite)); got != tc.want {
			t.Fatalf("%s:\n got  %s\n want %s", tc.name, got, tc.want)
		}
	}
	plain := `{"model":"m","input":"hi"}`
	if got := string(normalizeCodexOAuthBody([]byte(plain), false)); got != plain {
		t.Fatalf("unrelated body changed: %s", got)
	}
}

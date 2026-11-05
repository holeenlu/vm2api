package basispoints

import (
	"fmt"
	"strings"
	"testing"
)

// tool_choice 对齐 codex2api 原作者：none 不发目录；required 与指定工具降为 auto 并在协议说明里要求调用；
// allowed_tools 裁剪目录；其他形式按 auto。tool_choice 本身不再让请求改走原生。
func TestPrepareToolChoiceDegradesToAutoWithPromptRequirement(t *testing.T) {
	tools := `[{"type":"function","name":"inspect"},{"type":"function","name":"edit"},{"type":"namespace","name":"gh","tools":[{"type":"function","name":"search"}]}]`
	prepare := func(choice string) (string, *Bridge) {
		t.Helper()
		body := []byte(fmt.Sprintf(`{"model":"gpt-6-astra","tools":%s,"tool_choice":%s,"input":"hello"}`, tools, choice))
		before := string(body)
		prepared, bridge, err := Prepare(body, "", nil)
		if err != nil || bridge == nil {
			t.Fatalf("tool_choice %s failed: %v", choice, err)
		}
		if string(body) != before {
			t.Fatal("preparation changed the client's request")
		}
		return string(prepared), bridge
	}
	if auto, _ := prepare(`"auto"`); strings.Contains(auto, "The client requires") {
		t.Fatal("auto adds no requirement")
	}
	if none, _ := prepare(`"none"`); strings.Contains(none, "Client tool catalog") {
		t.Fatal("none sends no catalog")
	}
	if required, _ := prepare(`"required"`); !strings.Contains(required, "call at least one client tool") {
		t.Fatalf("required: %s", required)
	}
	for _, choice := range []string{`{"type":"function","name":"edit"}`, `{"type":"function","function":{"name":"edit"}}`} {
		if named, _ := prepare(choice); !strings.Contains(named, `call client tool \"edit\"`) {
			t.Fatalf("named %s: %s", choice, named)
		}
	}
	_, bridge := prepare(`{"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"inspect"},{"type":"function","namespace":"gh","name":"search"}]}`)
	if _, ok := bridge.tools["inspect"]; !ok || len(bridge.tools) != 2 {
		t.Fatalf("allowed_tools must keep only the allowed tools: %v", bridge.tools)
	}
	if _, ok := bridge.tools["edit"]; ok {
		t.Fatal("edit is not allowed")
	}
	if hosted, _ := prepare(`{"type":"web_search"}`); strings.Contains(hosted, "The client requires") {
		t.Fatal("a forced hosted tool behaves as auto")
	}
}

func TestUnsupportedHostedToolsReason(t *testing.T) {
	cases := []struct {
		body, want string
	}{
		{`{"tools":[{"type":"image_generation"}]}`, "image_generation"},
		{`{"tools":[{"type":"web_search","external_web_access":true}]}`, "web_search"},
		{`{"tools":[{"type":"function","name":"exec"}]}`, ""},
		{`{"tools":[{"type":"web_search","external_web_access":true}],"tool_choice":"none"}`, ""},
		{`{"tool_choice":{"type":"web_search"}}`, "tool_choice"},
		{`{"tool_choice":{"type":"image_generation"}}`, "tool_choice"},
		{`{"tool_choice":{"type":"function","name":"web_search_client"}}`, ""},
		{`{"tool_choice":{"type":"custom","name":"image_generation_client"}}`, ""},
	}
	for _, tc := range cases {
		if got := UnsupportedHostedToolsReason([]byte(tc.body)); got != tc.want {
			t.Errorf("reason=%q want %q for %s", got, tc.want, tc.body)
		}
	}
}

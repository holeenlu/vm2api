package basispoints

import (
	"encoding/json"
	"strings"
	"testing"
)

// codex2api 原作者 a55e1ec4：内置 local_shell / shell / apply_patch 作为同名目录函数中继，
// 客户端收到原生调用项；历史中的原生调用与结果降为 function_call / function_call_output。
func TestBuiltinClientToolsRelayAsNativeCalls(t *testing.T) {
	source := testSource()
	source["tools"] = []any{object{"type": "shell"}, object{"type": "apply_patch"}, object{"type": "local_shell"}}
	body, bridge := mustPrepare(t, source, "", nil)
	raw, _ := json.Marshal(body)
	for _, name := range []string{"shell", "apply_patch", "local_shell"} {
		if !strings.Contains(string(raw), `Client tool \"`+name+`\" (function)`) {
			t.Fatalf("catalog misses %s: %s", name, raw)
		}
	}
	response := object{"output": []any{
		nativeCall(object{"name": "shell", "arguments": object{"commands": []any{"ls -la"}, "timeout_ms": json.Number("5000")}}),
	}}
	if err := bridge.translateResponse(response); err != nil {
		t.Fatal(err)
	}
	call, _ := response["output"].([]any)[0].(object)
	action, _ := call["action"].(object)
	if call["type"] != "shell_call" || !strings.HasPrefix(text(call["id"]), "sh_") || call["call_id"] != "call_native" || action["timeout_ms"] != json.Number("5000") {
		t.Fatalf("client item=%+v", call)
	}
	commands, _ := action["commands"].([]any)
	if len(commands) != 1 || commands[0] != "ls -la" {
		t.Fatalf("commands=%v", action["commands"])
	}
	patch := object{"output": []any{nativeCall(object{"name": "apply_patch", "arguments": object{"type": "update_file", "path": "a.go", "diff": ""}})}}
	if err := bridge.translateResponse(patch); err == nil {
		t.Fatal("an empty update_file diff must be rejected")
	}

	// 历史：原生调用与结果降为函数调用与文本结果后照常转换
	source["input"] = []any{
		message("user", "list files"),
		object{"type": "shell_call", "id": "sh_1", "call_id": "call_sh", "status": "completed", "action": object{"commands": []any{"ls"}}},
		object{"type": "shell_call_output", "call_id": "call_sh", "output": []any{object{"stdout": "a.go", "outcome": object{"type": "exit", "exit_code": json.Number("0")}}}},
		message("user", "next"),
	}
	history, _ := mustPrepare(t, source, "", nil)
	encoded, _ := json.Marshal(history)
	if !strings.Contains(string(encoded), "Command 1 exited with code 0") || strings.Contains(string(encoded), "shell_call_output") {
		t.Fatalf("history=%s", encoded)
	}
	if strings.Contains(string(encoded), `"type":"shell_call"`) {
		t.Fatalf("native built-in items must not reach BPS: %s", encoded)
	}

	// 已有同名客户端工具时保留客户端声明
	source["tools"] = []any{object{"type": "shell"}, object{"type": "function", "name": "shell", "parameters": object{"type": "object"}}}
	source["input"] = "hello"
	_, own := mustPrepare(t, source, "", nil)
	if own.builtinTools["shell"] {
		t.Fatal("a client tool named shell keeps the name")
	}
}

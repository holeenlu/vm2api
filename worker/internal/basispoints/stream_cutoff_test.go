package basispoints

import (
	"io"
	"strings"
	"testing"
)

// 对齐 codex2api 原作者 TestStreamCompletesResponseCutOffAfterLastItem：上游在 response.completed 前干净结束，
// 但最后一项已是最终答案（或工具调用）时补出终态；最后一项是 commentary 时交还错误，由客户端重试。
func TestStreamCompletesResponseCutOffAfterLastItem(t *testing.T) {
	_, bridge, err := Prepare([]byte(`{"model":"gpt-test","stream":true,"input":"hi"}`), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	stream := "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\",\"status\":\"in_progress\",\"output\":[]}}\n\n" +
		"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n" +
		"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"answer\"}\n\n" +
		"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"answer\"}]}}\n\n"
	converted := bridge.Stream(io.NopCloser(strings.NewReader(stream)))
	out, err := io.ReadAll(converted)
	converted.Close()
	if err != nil || !strings.Contains(string(out), `"type":"response.completed"`) || !strings.Contains(string(out), `"id":"r1"`) {
		t.Fatalf("cut-off stream was not completed: err=%v %s", err, out)
	}

	commentary := strings.Replace(stream, `"phase":"final_answer"`, `"phase":"commentary"`, 1)
	converted = bridge.Stream(io.NopCloser(strings.NewReader(commentary)))
	_, err = io.ReadAll(converted)
	converted.Close()
	if err == nil {
		t.Fatal("a stream cut after commentary must not be completed")
	}

	unfinished := stream + "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n"
	converted = bridge.Stream(io.NopCloser(strings.NewReader(unfinished)))
	_, err = io.ReadAll(converted)
	converted.Close()
	if err == nil {
		t.Fatal("a stream cut with an unfinished item must not be completed")
	}
}

// Codex 会话中途切换推理强度时在历史里写 configuration_update；BPS 没有这种项，转换时去掉。
// 取最后一次切换的值，以请求顶层强度为上限；顶层没给时直接用切换值。
func TestPrepareDropsConfigurationUpdate(t *testing.T) {
	history := `[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},` +
		`{"type":"configuration_update","reasoning":{"effort":"low"}},` +
		`{"type":"configuration_update","reasoning":{"effort":"high"}},` +
		`{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]`
	body, bridge, err := Prepare([]byte(`{"model":"gpt-test","stream":true,"input":`+history+`}`), "", nil)
	if err != nil {
		t.Fatalf("configuration_update must not reject the request: %v", err)
	}
	if bridge.Effort != "high" || strings.Contains(string(body), "configuration_update") || !strings.Contains(string(body), `"reasoning_effort":"high"`) {
		t.Fatalf("effort=%s body=%s", bridge.Effort, body)
	}
	for top, want := range map[string]string{"low": "low", "medium": "medium", "xhigh": "high", "high": "high"} {
		_, bridge, err = Prepare([]byte(`{"model":"gpt-test","stream":true,"reasoning":{"effort":"`+top+`"},"input":`+history+`}`), "", nil)
		if err != nil || bridge.Effort != want {
			t.Fatalf("top=%s: the switch (high) is capped by the top-level effort: got %v err=%v want %s", top, bridge.Effort, err, want)
		}
	}
}

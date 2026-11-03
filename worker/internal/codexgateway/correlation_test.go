package codexgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestScopeCorrelationBodyMapsIDsAndDropsTrace(t *testing.T) {
	body := []byte(`{"model":"m","prompt_cache_key":"pck","session_id":"s1","turn_id":"t1","traceparent":"tp","client_metadata":{"thread_id":"th","baggage":"b","x-codex-turn-metadata":"{\"session_id\":\"s1\",\"note\":\"é\"}"},"input":[]}`)
	out := scopeCorrelationBody(body, "install-a")
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["session_id"] != scopedID("install-a", "s1") || got["prompt_cache_key"] != scopedID("install-a", "pck") {
		t.Fatalf("ids not scoped: %s", out)
	}
	if got["turn_id"] != "t1" || got["traceparent"] != nil {
		t.Fatalf("turn id must stay and trace must drop: %s", out)
	}
	meta := got["client_metadata"].(map[string]any)
	if meta["thread_id"] != scopedID("install-a", "th") || meta["baggage"] != nil {
		t.Fatalf("client_metadata=%v", meta)
	}
	turn := meta["x-codex-turn-metadata"].(string)
	// 字符串形式的 turn metadata 按 ASCII 编码（可放入 HTTP 头）
	if !strings.Contains(turn, scopedID("install-a", "s1")) || !strings.Contains(turn, `\u00e9`) {
		t.Fatalf("turn metadata=%q", turn)
	}
	// 字段顺序保持
	if !strings.HasPrefix(string(out), `{"model":"m","prompt_cache_key":`) {
		t.Fatalf("order changed: %s", out)
	}
	// 同一原值同账号等值，不同账号不同
	if scopedID("install-a", "s1") == scopedID("install-b", "s1") {
		t.Fatal("scoped ids must differ across accounts")
	}
}

func TestOAuthResponsesBodyIsZstdCompressed(t *testing.T) {
	var encoding string
	var decoded []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		encoding = r.Header.Get("Content-Encoding")
		raw, _ := io.ReadAll(r.Body)
		decoder, _ := zstd.NewReader(nil)
		decoded, _ = decoder.DecodeAll(raw, nil)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, okResponse)
	}))
	defer upstream.Close()
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok"))
	response, _ := run(t, cfg, httpServer.URL, false)
	if response.StatusCode != 200 || encoding != "zstd" || !strings.Contains(string(decoded), `"model":"gpt-test"`) {
		t.Fatalf("status=%d encoding=%q decoded=%s", response.StatusCode, encoding, decoded)
	}
}

func TestRequestKindDetectsCompaction(t *testing.T) {
	if requestKind([]byte(`{"request_kind":"compaction"}`)) != "compaction" || requestKind([]byte(`{"input":[{"type":"compaction_trigger"}]}`)) != "compaction" || requestKind([]byte(`{"input":"hi"}`)) != "" {
		t.Fatal("compaction detection")
	}
}

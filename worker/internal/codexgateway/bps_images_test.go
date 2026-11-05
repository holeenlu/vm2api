package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func runBPSImages(t *testing.T, cfg Config, baseURL, body string, policy SchedulingPolicy, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, baseURL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, Scheduling: policy, Headers: headers})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

func imageMessage(images int) string {
	parts := []string{`{"type":"input_text","text":"look"}`}
	for i := 0; i < images; i++ {
		parts = append(parts, `{"type":"input_image","image_url":"data:image/png;base64,`+bpsTestPNG+`"}`)
	}
	return `{"type":"message","role":"user","content":[` + strings.Join(parts, ",") + `]}`
}

func imageRequest(thread string, items ...string) string {
	return `{"model":"gpt-test","stream":true,"prompt_cache_key":"` + thread + `","input":[` + strings.Join(items, ",") + `]}`
}

const assistantTurn = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"seen"}]}`

func imagePolicy(settings BPSImageSettings) SchedulingPolicy {
	return SchedulingPolicy{BPSEnabled: true, BPSImages: &settings}
}

func TestBPSImageSettingsDefaults(t *testing.T) {
	got := BPSImageSettings{Policy: "bogus", MaxImageMiB: 999, MaxTotalMiB: 999, WarningRemaining: 50, CompactReserve: 0}.normalized()
	want := BPSImageSettings{Policy: "auto_compact", MaxImages: 20, MaxImageMiB: 32, MaxTotalMiB: 64, WarningRemaining: 8, CompactReserve: 0}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
	if got := (&dispatchRun{}).bpsImageSettings(); got != defaultBPSImageSettings || got.CompactReserve != 3 {
		t.Fatalf("defaults=%+v", got)
	}
}

func TestBPSImageWarnPolicyRecommendsOnceThenBlocksAtTheLimit(t *testing.T) {
	_, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	policy := imagePolicy(BPSImageSettings{Policy: "warn", MaxImages: 5, WarningRemaining: 3, CompactReserve: 1})
	request := imageRequest("warn-1", imageMessage(2))
	response, body := runBPSImages(t, cfg, httpServer.URL, request, policy, nil)
	if response.StatusCode != 400 || !strings.Contains(string(body), "basispoints_image_compact_recommended") {
		t.Fatalf("first approach to the limit must warn: status=%d body=%s", response.StatusCode, body)
	}
	if response, body = runBPSImages(t, cfg, httpServer.URL, request, policy, nil); response.StatusCode != 200 {
		t.Fatalf("the warning is shown once: status=%d body=%s", response.StatusCode, body)
	}
	response, body = runBPSImages(t, cfg, httpServer.URL, imageRequest("warn-1", imageMessage(5)), policy, nil)
	if response.StatusCode != 400 || !strings.Contains(string(body), "basispoints_image_limit_reached") {
		t.Fatalf("over limit-reserve must block: status=%d body=%s", response.StatusCode, body)
	}
}

func TestBPSImageOffPolicyDoesNotLimitTheCount(t *testing.T) {
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBPSImages(t, cfg, httpServer.URL, imageRequest("off-1", imageMessage(6)), imagePolicy(BPSImageSettings{Policy: "off", MaxImages: 3}), nil)
	if response.StatusCode != 200 || len(upstream.responses) != 1 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}

func TestBPSImageAutoCompactFallsBackToNativeForOtherClients(t *testing.T) {
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := imageRequest("auto-1", imageMessage(3), assistantTurn, imageMessage(2))
	response, body := runBPSImages(t, cfg, httpServer.URL, request, imagePolicy(BPSImageSettings{MaxImages: 4}), nil)
	if len(upstream.responses) != 0 || upstream.uploads != 0 || response.Header.Get(authModeHeader) == "bps" {
		t.Fatalf("non-Codex clients over the image limit must not use BPS: status=%d uploads=%d body=%s", response.StatusCode, upstream.uploads, body)
	}
	if attempts := attemptsOf(t, response); len(attempts) == 0 || attempts[0].Category != "bps_unsupported" {
		t.Fatalf("attempts=%s", response.Header.Get(attemptsHeader))
	}
}

func TestBPSImageAutoCompactCompactsHistoryOnTheSameAccount(t *testing.T) {
	compaction := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		output := []any{map[string]any{"type": "compaction", "id": "cmp_1", "encrypted_content": "sealed-history"}}
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "rc", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.completed", "response": map[string]any{"id": "rc", "status": "completed", "output": output, "usage": map[string]any{"input_tokens": 50, "output_tokens": 5}}}))
	}
	upstream, server := newBPSPathUpstream(t, compaction, bpsTextReply("r", "after compaction"))
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	request := imageRequest("auto-2", imageMessage(3), assistantTurn, imageMessage(2))
	response, body := runBPSImages(t, cfg, httpServer.URL, request, imagePolicy(BPSImageSettings{MaxImages: 4}), map[string]string{"originator": "codex_cli_rs"})
	if response.StatusCode != 200 || !strings.Contains(string(body), "after compaction") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if len(upstream.responses) != 2 {
		t.Fatalf("expected compaction + generation, got %d", len(upstream.responses))
	}
	first, second := string(upstream.responses[0]), string(upstream.responses[1])
	if !strings.Contains(first, "compaction_trigger") || strings.Contains(second, "compaction_trigger") {
		t.Fatalf("compaction body=%s\ngeneration body=%s", first, second)
	}
	if !strings.Contains(second, "sealed-history") {
		t.Fatalf("generation must start from the compacted window: %s", second)
	}
	if !strings.Contains(string(body), "sealed-history") {
		t.Fatalf("the compacted window must be returned to the client as an output prefix: %s", body)
	}
}

func TestBPSAttachmentRateLimitRetriesOnceOnTheSameAccount(t *testing.T) {
	limited := 0
	upstream, server := newBPSPathUpstream(t, bpsTextReply("r", "seen"))
	inner := server.Config.Handler
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bps/attachments" && limited == 0 {
			limited++
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error","message":"slow down"}}`)
			return
		}
		inner.ServeHTTP(w, r)
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBPSImages(t, cfg, httpServer.URL, imageRequest("retry-1", imageMessage(1)), bpsOn, nil)
	if response.StatusCode != 200 || upstream.uploads != 1 || limited != 1 {
		t.Fatalf("status=%d uploads=%d body=%s", response.StatusCode, upstream.uploads, body)
	}
}

func TestBPSAttachmentRetryDelayIsClamped(t *testing.T) {
	for value, want := range map[string]string{"0": "1s", "3": "3s", "60": "5s"} {
		if got := bpsAttachmentRetryDelay(value).String(); got != want {
			t.Fatalf("%s: got %s want %s", value, got, want)
		}
	}
}

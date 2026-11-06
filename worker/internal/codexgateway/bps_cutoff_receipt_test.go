package codexgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// bpsCutoffReply 发完最终答案项后在 response.completed 之前断开；progress 非空时先发一条带用量的 in_progress。
func bpsCutoffReply(id, text string, progress map[string]any) func(http.ResponseWriter) {
	message := map[string]any{"type": "message", "id": "msg_" + id, "role": "assistant", "status": "completed", "phase": "final_answer", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		stream := bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": id, "output": []any{}}})
		if progress != nil {
			stream += bpsEvent(map[string]any{"type": "response.in_progress", "response": map[string]any{"id": id, "usage": progress}})
		}
		stream += bpsEvent(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "message", "id": "msg_" + id, "role": "assistant", "content": []any{}}}) +
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg_" + id, "delta": text}) +
			bpsEvent(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": message})
		_, _ = io.WriteString(w, stream)
	}
}

// 审计 C1：BPS 断流后补出的完成终态，回执标明 bps_cutoff_completed，用量一律按 partial（已消耗下限）记录；
// 断流前没有用量时回执不带用量，由控制面明确按不计量处理
func TestBPSCutoffCompletionReceiptIsPartialAndMarked(t *testing.T) {
	for name, tc := range map[string]struct {
		progress   map[string]any
		confidence string
		output     any
	}{
		"usage seen before the cut-off": {map[string]any{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}, "partial", float64(3)},
		"no usage before the cut-off":   {nil, "unknown", nil},
	} {
		t.Run(name, func(t *testing.T) {
			_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsCutoffReply("r_cut", "answer", tc.progress)}})
			_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
			response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
			if response.StatusCode != 200 || !strings.Contains(string(body), "response.completed") || !strings.Contains(string(body), "answer") {
				t.Fatalf("the client still gets the completed answer: status=%d body=%s", response.StatusCode, body)
			}
			receipt := readReceipt(t, cfg)
			if receipt["terminal_state"] != terminalCompleted || receipt["error_code"] != bpsCutoffCompleted || receipt["usage_confidence"] != tc.confidence {
				t.Fatalf("receipt terminal=%v error=%v confidence=%v", receipt["terminal_state"], receipt["error_code"], receipt["usage_confidence"])
			}
			usage, _ := receipt["usage"].(map[string]any)
			if tc.output == nil && receipt["usage"] != nil || tc.output != nil && usage["output_tokens"] != tc.output {
				t.Fatalf("receipt usage=%v", receipt["usage"])
			}
		})
	}
}

// 正常完成的 BPS 流不带断流标记，用量照常为 complete
func TestBPSCompletedStreamIsNotMarkedAsCutoff(t *testing.T) {
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r_ok", "hello")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	if response, _ := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn); response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	receipt := readReceipt(t, cfg)
	if receipt["error_code"] != nil || receipt["usage_confidence"] != "complete" {
		t.Fatalf("receipt error=%v confidence=%v", receipt["error_code"], receipt["usage_confidence"])
	}
}

// 审计 C1 附带：BPS 流中断（无法补完成）时，回执按转换累计的已消耗用量记 partial（此前中途 in_progress 的计数被记成 complete），
// 供控制面按下限结算
func TestBPSInterruptedStreamReceiptCarriesPartialUsage(t *testing.T) {
	reply := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, bpsEvent(map[string]any{"type": "response.created", "response": map[string]any{"id": "r_cut", "output": []any{}}})+
			bpsEvent(map[string]any{"type": "response.in_progress", "response": map[string]any{"id": "r_cut", "usage": map[string]any{"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}}})+
			bpsEvent(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "message", "id": "msg_cut", "role": "assistant", "content": []any{}}})+
			bpsEvent(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg_cut", "delta": "partial"}))
	}
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {reply}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	receipt := readReceipt(t, cfg)
	usage, _ := receipt["usage"].(map[string]any)
	// 转换中断按复制错误记为 ambiguous（已发出、结果不明）；用量只是中途计数，必须是 partial
	if receipt["terminal_state"] != terminalAmbiguous || receipt["usage_confidence"] != "partial" || usage["input_tokens"] != float64(5) {
		t.Fatalf("receipt terminal=%v confidence=%v usage=%v", receipt["terminal_state"], receipt["usage_confidence"], receipt["usage"])
	}
}

// 审计复核 V1：断流补完成时，交付给调用方的终态含图片压缩窗口用量（107/23），转换累计不含（7/3）；
// 回执取逐项较大值，不能用转换累计覆盖。数值类型混合（JSON 解析的 float64 与转换器的 json.Number）
func TestMaxUsageKeepsTheLargerCountersAcrossNumberTypes(t *testing.T) {
	observed := map[string]any{"input_tokens": float64(107), "output_tokens": float64(23), "input_tokens_details": map[string]any{"cached_tokens": float64(1000000)}}
	converted := map[string]any{"input_tokens": json.Number("7"), "output_tokens": json.Number("30"), "input_tokens_details": map[string]any{"cached_tokens": json.Number("5")}, "total_tokens": json.Number("37")}
	got := maxUsage(observed, converted)
	details, _ := got["input_tokens_details"].(map[string]any)
	if got["input_tokens"] != float64(107) || got["output_tokens"] != json.Number("30") || got["total_tokens"] != json.Number("37") || details["cached_tokens"] != float64(1000000) {
		t.Fatalf("merged=%v", got)
	}
	if merged := maxUsage(nil, converted); merged["input_tokens"] != json.Number("7") {
		t.Fatalf("merged=%v", merged)
	}
	// 复核 W2：逐项取大后总量按输入加输出补正
	if fixed := withConsistentTotal(got); fixed["total_tokens"] != json.Number("137") {
		t.Fatalf("total=%v", fixed["total_tokens"])
	}
}

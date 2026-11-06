package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func runScoped(t *testing.T, cfg Config, baseURL, body string) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, baseURL, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}, ClientScope: "key-1", Scheduling: SchedulingPolicy{BPSEnabled: true, Strategy: "round_robin"}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

func TestBPSContinuationExpandsTheSnapshotOnTheSameAccount(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {bpsTextReply("resp_first", "first answer"), bpsTextReply("resp_second", "second answer")},
		"bps_tok_b": {bpsTextReply("resp_b", "from b"), bpsTextReply("resp_b2", "from b again")},
	})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"), bpsAccount("b", "tok_b"))
	response, body := runScoped(t, cfg, httpServer.URL, `{"model":"gpt-test","stream":true,"input":"first question"}`)
	if response.StatusCode != 200 || !strings.Contains(string(body), "resp_first") && !strings.Contains(string(body), "resp_b") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	first := "resp_first"
	owner, other := "bps_tok_a", "bps_tok_b"
	if upstream.count("bps_tok_a") == 0 {
		first, owner, other = "resp_b", "bps_tok_b", "bps_tok_a"
	}
	before := upstream.count(other)
	response, body = runScoped(t, cfg, httpServer.URL, `{"model":"gpt-test","stream":true,"previous_response_id":"`+first+`","input":"second question"}`)
	if response.StatusCode != 200 || upstream.count(other) != before || upstream.count(owner) != 2 {
		t.Fatalf("continuation must stay on the producing account: status=%d owner=%d other=%d body=%s", response.StatusCode, upstream.count(owner), upstream.count(other), body)
	}
	sent := string(upstream.bodies[owner])
	if !strings.Contains(sent, "first question") || !strings.Contains(sent, "second question") || strings.Contains(sent, "previous_response_id") {
		t.Fatalf("BPS must receive the expanded history: %s", sent)
	}
	if !strings.Contains(sent, "first answer") && !strings.Contains(sent, "from b") {
		t.Fatalf("the previous output must be replayed: %s", sent)
	}
}

func TestBPSContinuationUnknownResponseKeepsTheNativeError(t *testing.T) {
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "x")}, "tok_a": {nativeReply("native")}})
	s, _, _ := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	run := &dispatchRun{server: s, envelope: Envelope{ClientScope: "key-1"}, body: []byte(`{"previous_response_id":"resp_unknown","input":"q"}`)}
	if s.expandBPSContinuation(run, "resp_unknown") || run.bpsContinued {
		t.Fatal("unknown response ids must not be expanded")
	}
}

// 续接快照：补回续接请求没带的 tools；授权代次变化后不展开；compaction 轮不保存；保存中的快照等它保存完（对齐 sub2api）
func TestBPSContinuationRestoresToolsAndChecksTheGrant(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {bpsTextReply("resp_first", "first answer"), bpsTextReply("resp_second", "second answer"), bpsTextReply("resp_c", "compacted")},
	})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	tools := `"tools":[{"type":"function","name":"keep_tool","parameters":{"type":"object","properties":{}}}]`
	if response, body := runScoped(t, cfg, httpServer.URL, `{"model":"gpt-test","stream":true,`+tools+`,"input":"first question"}`); response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if response, body := runScoped(t, cfg, httpServer.URL, `{"model":"gpt-test","stream":true,"previous_response_id":"resp_first","input":"second question"}`); response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if sent := string(upstream.bodies["bps_tok_a"]); !strings.Contains(sent, "keep_tool") || !strings.Contains(sent, "first question") {
		t.Fatalf("the continuation must restore the declared tools: %s", sent)
	}
	expand := func(previous string) bool {
		run := &dispatchRun{server: s, envelope: Envelope{ClientScope: "key-1"}, body: []byte(`{"model":"gpt-test","stream":true,"previous_response_id":"` + previous + `","input":"next"}`)}
		return s.expandBPSContinuation(run, previous)
	}
	if !expand("resp_second") {
		t.Fatal("the second response must have a snapshot")
	}
	// 重新授权（授权代次变化）后快照不再展开
	_, _ = s.store.UpdateBPS("a", func(account *Account) bool { account.BPS.Revision++; return true })
	if expand("resp_second") {
		t.Fatal("a snapshot of a replaced grant must not be expanded")
	}
	// compaction 轮不保存快照
	compaction := `{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]},{"type":"compaction_trigger"}]}`
	runScoped(t, cfg, httpServer.URL, compaction)
	_, _ = s.store.UpdateBPS("a", func(account *Account) bool { account.BPS.Revision = 1; return true })
	if expand("resp_c") {
		t.Fatal("a compaction turn must not leave a snapshot")
	}
}

func TestBPSContinuationWaitsForAPendingSnapshot(t *testing.T) {
	s, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	release := s.markBPSContinuationPending("key-1", "resp_pending")
	go func() {
		time.Sleep(100 * time.Millisecond)
		raw, _ := json.Marshal(bpsContinuationSnapshot{Version: bpsContinuationVersion, Account: "a", Revision: 1, CreatedAt: time.Now().UTC(), Input: []json.RawMessage{json.RawMessage(`{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}`)}, Output: []json.RawMessage{json.RawMessage(`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a"}]}`)}})
		_, _ = s.bps.disk.SaveBPSState(context.Background(), bpsContinuationScope("key-1"), "resp:resp_pending", nil, raw)
		release()
	}()
	run := &dispatchRun{server: s, envelope: Envelope{ClientScope: "key-1"}, body: []byte(`{"model":"gpt-test","stream":true,"previous_response_id":"resp_pending","input":"next"}`)}
	if !s.expandBPSContinuation(run, "resp_pending") || !strings.Contains(string(run.body), `"q"`) {
		t.Fatalf("the pending snapshot must be awaited: %s", run.body)
	}
	// 没有登记的响应不等待
	started := time.Now()
	other := &dispatchRun{server: s, envelope: Envelope{ClientScope: "key-1"}, body: []byte(`{"model":"gpt-test","previous_response_id":"resp_none","input":"x"}`)}
	if s.expandBPSContinuation(other, "resp_none") || time.Since(started) > 500*time.Millisecond {
		t.Fatal("an unknown response must not wait")
	}
}

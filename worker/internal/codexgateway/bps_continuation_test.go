package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
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

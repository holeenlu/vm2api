package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/klauspost/compress/zstd"
)

const rejectedCiphertext = `{"error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed."}}`

// bodyRecordingUpstream 按令牌依次返回脚本应答，并记下每次收到的请求正文。
type bodyRecordingUpstream struct {
	mu      sync.Mutex
	scripts map[string][]func(http.ResponseWriter)
	bodies  map[string][]string
}

func newBodyRecordingUpstream(t *testing.T, scripts map[string][]func(http.ResponseWriter)) (*bodyRecordingUpstream, *httptest.Server) {
	t.Helper()
	u := &bodyRecordingUpstream{scripts: scripts, bodies: map[string][]string{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		data, _ := io.ReadAll(r.Body)
		if r.Header.Get("Content-Encoding") == "zstd" {
			decoder, _ := zstd.NewReader(nil)
			data, _ = decoder.DecodeAll(data, nil)
			decoder.Close()
		}
		u.mu.Lock()
		index := len(u.bodies[token])
		u.bodies[token] = append(u.bodies[token], string(data))
		steps := u.scripts[token]
		u.mu.Unlock()
		if len(steps) == 0 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if index >= len(steps) {
			index = len(steps) - 1
		}
		steps[index](w)
	}))
	t.Cleanup(server.Close)
	return u, server
}

func (u *bodyRecordingUpstream) sent(token string) []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.bodies[token]...)
}

func runRequestBody(t *testing.T, cfg Config, url, body string, stream bool) (*http.Response, []byte) {
	t.Helper()
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, url, Envelope{Dispatch: fmt.Sprintf("d_%d", n), RequestID: fmt.Sprintf("r_%d", n), Nonce: fmt.Sprintf("n_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: stream, Body: json.RawMessage(body), Scope: Scope{GroupIDs: []int64{1}}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return response, data
}

func inputTypes(t *testing.T, body string) []string {
	t.Helper()
	var parsed struct {
		Input []map[string]any `json:"input"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("upstream body %q: %v", body, err)
	}
	var kinds []string
	for _, item := range parsed.Input {
		kind, _ := item["type"].(string)
		if _, enc := item["encrypted_content"]; enc {
			kind += "+enc"
		}
		kinds = append(kinds, kind)
	}
	return kinds
}

const cipherHistory = `{"model":"gpt-test","store":false,"input":[` +
	`{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},` +
	`{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"ENC_R"},` +
	`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}],"encrypted_content":"ENC_M"},` +
	`{"type":"function_call","call_id":"c1","name":"f","arguments":"{}","encrypted_content":"ENC_F"},` +
	`{"type":"compaction","id":"cmp_1","encrypted_content":"ENC_C"},` +
	`{"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}]}`

func TestReduceEncryptedHistorySteps(t *testing.T) {
	first, ok := reduceEncryptedHistory([]byte(cipherHistory), false)
	if !ok {
		t.Fatal("step 1 must reduce reasoning and replay ciphertext")
	}
	if got := strings.Join(inputTypes(t, string(first)), ","); got != "message,message,function_call,compaction+enc,message" {
		t.Fatalf("step 1 input=%s", got)
	}
	if !strings.Contains(string(first), `"text":"answer"`) || !strings.Contains(string(first), `"call_id":"c1"`) {
		t.Fatalf("visible content must stay: %s", first)
	}
	if !strings.HasPrefix(string(first), `{"model":"gpt-test","store":false,"input":`) {
		t.Fatalf("field order must stay: %s", first)
	}
	second, ok := reduceEncryptedHistory(first, true)
	if !ok || strings.Contains(string(second), "ENC_") || !strings.Contains(string(second), omittedCompactionNotice) {
		t.Fatalf("step 2 must replace the compaction: ok=%v %s", ok, second)
	}
	if _, ok := reduceEncryptedHistory(second, true); ok {
		t.Fatal("nothing left to reduce")
	}
	continued := `{"previous_response_id":"resp_1","input":[{"type":"reasoning","encrypted_content":"E"}]}`
	if _, ok := reduceEncryptedHistory([]byte(continued), true); ok {
		t.Fatal("a continuation of stored state is not recovered")
	}
	if !compactionRejected([]byte(cipherHistory), upstreamFailure{Code: "invalid_encrypted_content", Message: "The encrypted content for item cmp_1 could not be verified."}) {
		t.Fatal("a rejection naming the compaction goes straight to step 2")
	}
	if compactionRejected([]byte(cipherHistory), upstreamFailure{Code: "invalid_encrypted_content", Message: "The encrypted content for item rs_1 could not be verified."}) {
		t.Fatal("a rejection naming reasoning keeps the compaction")
	}
}

func TestEncryptedHistoryRejectedSignals(t *testing.T) {
	for _, failure := range []upstreamFailure{
		{Code: "invalid_encrypted_content"},
		{Code: "invalid_compaction"},
		{Message: "The encrypted content for item rs_x could not be verified. Reason: Encrypted content could not be decrypted or parsed."},
	} {
		if !encryptedHistoryRejected(failure) {
			t.Fatalf("not recognised: %+v", failure)
		}
	}
	for _, failure := range []upstreamFailure{
		{Code: "invalid_request", Message: "The encrypted content for item rs_x could not be verified."},
		{Code: "server_is_overloaded"},
		{Message: "user said: the encrypted content could not be verified"},
	} {
		if encryptedHistoryRejected(failure) {
			t.Fatalf("false positive: %+v", failure)
		}
	}
}

func TestEncryptedHistoryRejectionRecoversOnSameAccount(t *testing.T) {
	upstream, server := newBodyRecordingUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(400, rejectedCiphertext), jsonReply(200, okResponse)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	first := account("a", "tok_a")
	first.Weight = 100
	gw, httpServer, cfg := newExecuteServer(t, server.URL, first, account("b", "tok_b"))
	response, body := runRequestBody(t, cfg, httpServer.URL, cipherHistory, false)
	sent := upstream.sent("tok_a")
	if response.StatusCode != 200 || len(sent) != 2 || len(upstream.sent("tok_b")) != 0 {
		t.Fatalf("status=%d a=%d b=%d body=%s", response.StatusCode, len(sent), len(upstream.sent("tok_b")), body)
	}
	if got := strings.Join(inputTypes(t, sent[1]), ","); got != "message,message,function_call,compaction+enc,message" {
		t.Fatalf("retry input=%s", got)
	}
	if saved, _ := gw.store.Get("a"); !saved.CooldownUntil.IsZero() || saved.CredentialState != "" {
		t.Fatalf("the account is not at fault: %+v", publicAccount(saved))
	}

	// 流内拒绝（首个生成内容之前）同样恢复：先去推理密文，仍被拒再替换 compaction，再被拒交付原错误
	failedOn := func(item string) string {
		return `{"type":"response.failed","response":{"error":{"code":"invalid_encrypted_content","message":"The encrypted content for item ` + item + ` could not be verified."}}}`
	}
	reasoning := sseReply(failedOn("rs_1"))
	streamed, server2 := newBodyRecordingUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {reasoning, reasoning, reasoning},
	})
	_, httpServer2, cfg2 := newExecuteServer(t, server2.URL, account("a", "tok_a"))
	response, body = runRequestBody(t, cfg2, httpServer2.URL, cipherHistory, true)
	sent = streamed.sent("tok_a")
	if len(sent) != 1+encryptedHistoryMaxRecoveries || !strings.Contains(string(body), "invalid_encrypted_content") {
		t.Fatalf("calls=%d status=%d body=%s", len(sent), response.StatusCode, body)
	}
	if !strings.Contains(sent[1], "ENC_C") || strings.Contains(sent[1], "ENC_R") || strings.Contains(sent[2], "ENC_C") {
		t.Fatalf("reductions: first=%s second=%s", sent[1], sent[2])
	}

	// 拒绝点名 compaction：第一次缩减就替换它，之后没有可去掉的密文，不再重发
	compaction := sseReply(failedOn("cmp_1"))
	named, server3 := newBodyRecordingUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {compaction, compaction, compaction},
	})
	_, httpServer3, cfg3 := newExecuteServer(t, server3.URL, account("a", "tok_a"))
	_, _ = runRequestBody(t, cfg3, httpServer3.URL, cipherHistory, true)
	sent = named.sent("tok_a")
	if len(sent) != 2 || strings.Contains(sent[1], "ENC_") || !strings.Contains(sent[1], omittedCompactionNotice) {
		t.Fatalf("calls=%d first reduction=%s", len(sent), sent[len(sent)-1])
	}
}

func TestHistoryOwnerPreferredForNativeCiphertext(t *testing.T) {
	upstream, server := newBodyRecordingUpstream(t, map[string][]func(http.ResponseWriter){
		"tok_a": {jsonReply(200, `{"id":"resp_ok","output":[{"type":"reasoning","summary":[],"encrypted_content":"ENC_OUT"}],"usage":{"input_tokens":1,"output_tokens":1}}`)},
		"tok_b": {jsonReply(200, okResponse)},
	})
	first := account("a", "tok_a")
	first.Weight = 100
	gw, httpServer, cfg := newExecuteServer(t, server.URL, first, account("b", "tok_b"))
	gw.provenance.recordOwned("", routeNative, "b", []string{encryptedKey("ENC_R")})
	response, _ := runRequestBody(t, cfg, httpServer.URL, cipherHistory, false)
	if response.StatusCode != 200 || len(upstream.sent("tok_b")) != 1 || len(upstream.sent("tok_a")) != 0 {
		t.Fatalf("status=%d a=%d b=%d", response.StatusCode, len(upstream.sent("tok_a")), len(upstream.sent("tok_b")))
	}
	// 最新一轮的密文决定归属
	gw.provenance.recordOwned("", routeNative, "a", []string{encryptedKey("ENC_F")})
	if owner := gw.provenance.owner("", historyKeys([]byte(cipherHistory))); owner != "a" {
		t.Fatalf("owner=%q", owner)
	}
	// 签发账号停用：正常选号
	gw.provenance.recordOwned("", routeNative, "b", []string{encryptedKey("ENC_F")})
	_, _ = gw.store.Patch("b", map[string]any{"enabled": false})
	response, _ = runRequestBody(t, cfg, httpServer.URL, cipherHistory, false)
	if response.StatusCode != 200 || len(upstream.sent("tok_a")) != 1 {
		t.Fatalf("status=%d a=%d", response.StatusCode, len(upstream.sent("tok_a")))
	}
	// 签发记录随响应交付写入（原生输出密文带账号）；response id 不再记录
	if entry := gw.provenance.entries[provenanceKey("", encryptedKey("ENC_OUT"))]; entry.Route != routeNative || entry.Account != "a" {
		t.Fatalf("recorded entry=%+v", entry)
	}
	if _, ok := gw.provenance.entries[provenanceKey("", "resp:resp_ok")]; ok {
		t.Fatal("response ids must not be recorded")
	}
}

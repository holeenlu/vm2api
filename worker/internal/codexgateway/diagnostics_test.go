package codexgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 上游 WS 在终态前断开：诊断（关闭码、关闭原因、最后事件、连接退出原因）经 trailer 交给控制面，流本身不变。
func TestWSMidStreamCloseReportsDiagnosticTrailer(t *testing.T) {
	fake := &fakeWSUpstream{script: func(conn int32, turn int) []string {
		return []string{`{"type":"response.created","response":{"id":"$ID"}}`, `{"type":"response.output_text.delta","delta":"partial"}`, "<close>"}
	}}
	_, httpServer, cfg := newWSGateway(t, fake, account("a", "tok_a"))
	n := nonceSeq.Add(1)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: fmt.Sprintf("d_dg_%d", n), RequestID: fmt.Sprintf("r_dg_%d", n), Nonce: fmt.Sprintf("n_dg_%d", n), Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Stream: true, ClientScope: "key_1", Body: json.RawMessage(`{"model":"gpt-test","stream":true,"input":"hi"}`), Scope: Scope{GroupIDs: []int64{1}, SessionID: "s_diag"}})
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	diagnostic := response.Trailer.Get(gatewayDiagnosticTrailer)
	if strings.Contains(string(data), "kin") || !strings.Contains(diagnostic, `"websocket_close_code":1000`) || !strings.Contains(diagnostic, `"connection_exit_reason":"closed_by_upstream"`) || !strings.Contains(diagnostic, `"last_event_type":"response.output_text.delta"`) {
		t.Fatalf("diagnostic trailer=%q body=%s", diagnostic, data)
	}
}

// 失败响应带结构化上游错误；尝试记录带上游 x-request-id。
func TestFailureCarriesUpstreamErrorAndRequestIDs(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-request-id", "req_up_1")
		w.Header().Set("cf-ray", "ray-1")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = io.WriteString(w, `{"error":{"type":"invalid_request_error","code":"bad_param","message":"field x","param":"input"}}`)
	}))
	defer upstream.Close()
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok_a"))
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_diag", RequestID: "r_diag", Nonce: "n_diag", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: json.RawMessage(`{"model":"gpt-test","input":"hi"}`), Scope: Scope{GroupIDs: []int64{1}}})
	_, _ = io.ReadAll(response.Body)
	response.Body.Close()
	var detail map[string]string
	_ = json.Unmarshal([]byte(response.Header.Get(upstreamErrorHeader)), &detail)
	if detail["code"] != "bad_param" || detail["param"] != "input" || detail["type"] != "invalid_request_error" {
		t.Fatalf("upstream error header=%q", response.Header.Get(upstreamErrorHeader))
	}
	var attempts []attemptRecord
	_ = json.Unmarshal([]byte(response.Header.Get(attemptsHeader)), &attempts)
	if len(attempts) == 0 || attempts[0].UpstreamRequestID != "req_up_1" || attempts[0].CFRay != "ray-1" || attempts[0].Message != "field x" {
		t.Fatalf("attempts=%+v", attempts)
	}
}

// 刷新失败记录结构化诊断（令牌脱敏），区分手动与定时来源；成功刷新后清除。
func TestRefreshFailureDiagnosticIsRedacted(t *testing.T) {
	fail := true
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if fail {
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"error":{"code":"temporarily_unavailable","message":"retry"},"refresh_token":"rt_secret"}`)
			return
		}
		_, _ = io.WriteString(w, `{"access_token":"tok_new"}`)
	}))
	defer tokenServer.Close()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", OAuthTokenURL: tokenServer.URL}
	cfg.applyDefaults()
	gw, _ := NewServer(cfg)
	acct := account("a", "tok")
	acct.RefreshToken = "rt_secret"
	_, _ = gw.store.Upsert(acct)
	_, _ = gw.refreshAccount("a")
	saved, _ := gw.store.Get("a")
	failure := saved.LastRefreshFailure
	if failure == nil || failure.Operation != "manual_refresh" || failure.Status != 400 || failure.Code != "temporarily_unavailable" || strings.Contains(failure.Message, "rt_secret") {
		t.Fatalf("failure=%+v", failure)
	}
	fail = false
	if _, err := gw.refreshAccount("a"); err != nil {
		t.Fatal(err)
	}
	if saved, _ := gw.store.Get("a"); saved.LastRefreshFailure != nil {
		t.Fatalf("a successful refresh must clear the diagnostic: %+v", saved.LastRefreshFailure)
	}
}

// 尝试记录的错误原文：优先上游 message，没有时取响应体开头；空白压缩、非 ASCII 替换、限长。
func TestAttemptErrorText(t *testing.T) {
	cases := []struct {
		message string
		body    string
		want    string
	}{
		{"  blocked by our\n usage   policy ", `{"ignored":true}`, "blocked by our usage policy"},
		{"", "<html>\n<title>403 Forbidden</title></html>", "<html> <title>403 Forbidden</title></html>"},
		{"拒绝 denied", "", "?? denied"},
		{"", "", ""},
	}
	for _, c := range cases {
		if got := attemptErrorText(c.message, []byte(c.body)); got != c.want {
			t.Fatalf("attemptErrorText(%q, %q)=%q, want %q", c.message, c.body, got, c.want)
		}
	}
	if got := attemptErrorText(strings.Repeat("x", 1000), nil); len(got) != attemptErrorTextLimit {
		t.Fatalf("len=%d", len(got))
	}
}

// 尝试摘要响应头过长时先只保留最后一次的错误原文，仍过长再全部去掉；尝试本身不丢。
func TestAttemptsJSONDropsMessagesWhenTooLong(t *testing.T) {
	d := &dispatchRun{}
	for i := 0; i < 40; i++ {
		d.attempts = append(d.attempts, attemptRecord{Account: "a", Status: 403, Message: strings.Repeat("m", attemptErrorTextLimit)})
	}
	var records []attemptRecord
	header := d.attemptsJSON()
	if err := json.Unmarshal([]byte(header), &records); err != nil || len(header) > attemptsHeaderSoftLimit || len(records) != 40 {
		t.Fatalf("len=%d records=%d err=%v", len(header), len(records), err)
	}
	if records[0].Message != "" || records[39].Message == "" {
		t.Fatalf("first=%q last=%q", records[0].Message, records[39].Message)
	}
	if d.attempts[0].Message == "" {
		t.Fatal("trimming the header must not change the recorded attempts")
	}
}

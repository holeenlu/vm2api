package codexgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func signedInternal(t *testing.T, cfg Config, method, url string, payload any) (*http.Response, map[string]any) {
	t.Helper()
	var body []byte
	if payload != nil {
		body, _ = json.Marshal(payload)
	}
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce := fmt.Sprintf("evt-%d", time.Now().UnixNano())
	req, _ := http.NewRequest(method, url, bytes.NewReader(body))
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", nonce)
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(body))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash(body), body))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return response, out
}

func eventsOfType(t *testing.T, s *Server, kind string) []executorEvent {
	t.Helper()
	all, err := s.events.read(0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var out []executorEvent
	for _, event := range all {
		if event.Type == kind {
			out = append(out, event)
		}
	}
	return out
}

func TestRequestFinalizedEventMatchesTheReceipt(t *testing.T) {
	_, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("resp_1", "hello")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != 200 {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	var finalized []executorEvent
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if finalized = eventsOfType(t, s, EventRequestFinalized); len(finalized) > 0 {
			break
		}
	}
	if len(finalized) != 1 {
		t.Fatalf("finalized events=%d", len(finalized))
	}
	event := finalized[0]
	entries, _ := os.ReadDir(cfg.ReceiptDir())
	if len(entries) != 1 {
		t.Fatalf("receipts=%d", len(entries))
	}
	receiptRaw, _ := os.ReadFile(filepath.Join(cfg.ReceiptDir(), entries[0].Name()))
	var receipt, payload map[string]any
	_ = json.Unmarshal(receiptRaw, &receipt)
	_ = json.Unmarshal(event.Payload, &payload)
	// 载荷与回执逐字段一致（含 attempts、usage、headers 与 payload_hash）
	if receipt["payload_hash"] == nil || !reflect.DeepEqual(payload, receipt) {
		t.Fatalf("event payload must equal the receipt:\nreceipt=%s\nevent=%s", receiptRaw, event.Payload)
	}
	if event.Subject["dispatch_id"] != receipt["dispatch_id"] || event.Subject["runtime_account_id"] != "a" || event.validate() != nil {
		t.Fatalf("subject=%v", event.Subject)
	}
}

func TestEventEndpointsPageAckAndDetectStreamChanges(t *testing.T) {
	s, httpServer, cfg := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	for i := 0; i < 3; i++ {
		s.recordBPSProbe(bpsProbeRecord{AccountID: "a", Model: "gpt-test", ProbedAt: time.Now().UTC().Add(time.Duration(i) * time.Second)})
	}
	stream := s.events.streamID
	response, out := signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/events?after=0&limit=2&stream_id="+stream, nil)
	events, _ := out["events"].([]any)
	if response.StatusCode != 200 || len(events) != 2 || out["next"].(float64) != 2 || out["stream_id"] != stream {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	first := events[0].(map[string]any)
	if first["type"] != EventProbeRecorded || !strings.HasPrefix(first["event_id"].(string), "evt_"+stream+"_") {
		t.Fatalf("first=%v", first)
	}
	if response, out = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/events/ack", map[string]any{"stream_id": stream, "seq": 2}); response.StatusCode != 200 || out["acked"].(float64) != 2 {
		t.Fatalf("ack status=%d out=%v", response.StatusCode, out)
	}
	if response, _ = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/events/ack", map[string]any{"stream_id": stream, "seq": 2}); response.StatusCode != 200 {
		t.Fatal("repeated ack must be idempotent")
	}
	if response, out = signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/events?after=0&stream_id=other", nil); response.StatusCode != http.StatusConflict || out["stream_id"] != stream {
		t.Fatalf("stream change status=%d out=%v", response.StatusCode, out)
	}
	if response, _ = signedInternal(t, cfg, http.MethodPost, httpServer.URL+"/internal/v1/events/ack", map[string]any{"stream_id": stream, "seq": 99}); response.StatusCode != http.StatusBadRequest {
		t.Fatal("ack beyond head must be rejected")
	}
	// 响应签名（P3.11）：绑定本次请求的随机串，正文被改即失效
	req, _ := http.NewRequest(http.MethodGet, httpServer.URL+"/internal/v1/events?after=0&stream_id="+stream, nil)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", "resp-nonce-1")
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(nil))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, "resp-nonce-1", BodyHash(nil), nil))
	signed, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(signed.Body)
	_ = signed.Body.Close()
	hash := BodyHash(raw)
	target := "/internal/v1/events?after=0&stream_id=" + stream
	if signed.Header.Get("X-Kin-Gateway-Response-Sha256") != hash || signed.Header.Get("X-Kin-Gateway-Response-Signature") != Sign(cfg.InternalToken, responseSignatureScope(200, target), "resp-nonce-1", hash, raw) {
		t.Fatalf("response signature missing or wrong: %v", signed.Header)
	}
	if Sign(cfg.InternalToken, responseSignatureScope(200, target), "other-nonce", hash, raw) == signed.Header.Get("X-Kin-Gateway-Response-Signature") || Sign(cfg.InternalToken, responseSignatureScope(409, target), "resp-nonce-1", hash, raw) == signed.Header.Get("X-Kin-Gateway-Response-Signature") || Sign(cfg.InternalToken, responseSignatureScope(200, "/internal/v1/events?after=5&stream_id="+stream), "resp-nonce-1", hash, raw) == signed.Header.Get("X-Kin-Gateway-Response-Signature") {
		t.Fatal("signature must be bound to the request nonce")
	}
	// 未签名的请求被拒
	if unsigned, err := http.Get(httpServer.URL + "/internal/v1/events"); err != nil || unsigned.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unsigned request must be rejected: %v %v", unsigned, err)
	}
}

func TestStateEventsAreEmittedOnlyOnChange(t *testing.T) {
	s, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	s.emitStateEvents()
	s.emitStateEvents()
	if states := eventsOfType(t, s, EventAccountState); len(states) != 1 {
		t.Fatalf("initial snapshot must be emitted once, got %d", len(states))
	}
	s.store.DisposeBPS("a", "gpt-test", upstreamFailure{Category: categoryBanned, Status: 403, bps: true}, time.Now())
	s.emitStateEvents()
	states := eventsOfType(t, s, EventAccountState)
	if len(states) != 2 || !strings.Contains(string(states[1].Payload), `"bps_state":"blocked"`) {
		t.Fatalf("states=%d last=%s", len(states), states[len(states)-1].Payload)
	}
	s.store.UpdateQuota("a", map[string]any{"primary_used_percent": 42.0, "primary_resets_at": time.Now().Add(time.Hour).Unix()})
	s.emitStateEvents()
	s.emitStateEvents()
	quotas := eventsOfType(t, s, EventAccountQuota)
	if len(quotas) != 1 || !strings.Contains(string(quotas[0].Payload), `"account_id":"a"`) {
		t.Fatalf("quota events=%d", len(quotas))
	}
}

func TestBrokenEventLogStopsAcceptingRequests(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("r", "x")}})
	s, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	s.events.mu.Lock()
	s.events.broken = errors.New("disk full")
	s.events.mu.Unlock()
	// 控制面未消费事件（默认）时，事件日志故障不影响接单
	if !s.events.accepting() {
		t.Fatal("an unconsumed event log must never block requests")
	}
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true}}}`))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, bpsOn)
	if response.StatusCode != http.StatusServiceUnavailable || response.Header.Get(sendStateHeader) != sendStateNotSent || !strings.Contains(string(body), "executor_event_log_unavailable") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	if upstream.count("bps_tok_a") != 0 {
		t.Fatal("no upstream call may happen while the event log is broken")
	}
	_, health := signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/health", nil)
	if health["health_state"] != "degraded" {
		t.Fatalf("health=%v", health)
	}
}

func TestUnconsumedEventLogSelfAcknowledgesAndNeverBlocks(t *testing.T) {
	s, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	s.events.maxBacklog = 10
	for i := 0; i < 5; i++ {
		s.recordBPSProbe(bpsProbeRecord{AccountID: "a", ProbedAt: time.Now().UTC()})
	}
	if !s.events.accepting() {
		t.Fatal("backlog must not block while the control plane does not consume events")
	}
	s.events.maintain()
	if status := s.events.status(); status.Acked != status.Head || status.BacklogBytes != 0 || status.Required {
		t.Fatalf("unconsumed log must self-acknowledge: %+v", status)
	}
	// 控制面开始消费后不再自行确认；积压超限时拒单
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true}}}`))
	s.recordBPSProbe(bpsProbeRecord{AccountID: "a", ProbedAt: time.Now().UTC()})
	s.events.maintain()
	if status := s.events.status(); status.Acked == status.Head || !status.Required {
		t.Fatalf("consumed log must wait for the control plane: %+v", status)
	}
	if s.events.accepting() {
		t.Fatal("over-limit backlog must block once events are required")
	}
	// shadow（required 但不 enforce）：保留事件、不自行确认，也不拒单（终审 A5）
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true,"enforce":false}}}`))
	if !s.events.accepting() {
		t.Fatal("shadow consumption must never block requests")
	}
	s.events.maintain()
	if status := s.events.status(); status.Acked == status.Head || !status.Required {
		t.Fatalf("shadow consumption must still wait for the control plane: %+v", status)
	}
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true,"enforce":true}}}`))
	if s.events.accepting() {
		t.Fatal("primary consumption blocks on an over-limit backlog")
	}
	// 旧版控制面不下发 executor_events：视为不消费
	s.applyHeartbeatPolicy([]byte(`{"policy":{}}`))
	if !s.events.accepting() {
		t.Fatal("missing policy must mean not required")
	}
}

// 控制面开始消费事件时补发一份完整账号终态（终审 A10）
func TestStartingConsumptionResendsTheAccountStateSnapshot(t *testing.T) {
	s, _, _ := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":false}}}`))
	s.emitStateEvents()
	s.emitStateEvents()
	before := len(eventsOfType(t, s, EventAccountState))
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true,"enforce":true}}}`))
	s.emitStateEvents()
	if after := len(eventsOfType(t, s, EventAccountState)); after != before+1 {
		t.Fatalf("snapshots before=%d after=%d", before, after)
	}
	// 已在消费：没有变化时不再重复发
	s.applyHeartbeatPolicy([]byte(`{"policy":{"executor_events":{"required":true,"enforce":true}}}`))
	s.emitStateEvents()
	if again := len(eventsOfType(t, s, EventAccountState)); again != before+1 {
		t.Fatalf("unchanged state must not be resent: %d", again)
	}
}

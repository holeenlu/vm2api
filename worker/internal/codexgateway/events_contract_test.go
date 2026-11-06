package codexgateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 控制面 src/lib/executor/contract.mjs 与本文件用同一份夹具校验事件信封，保证两边定义一致。
func TestExecutorEventFixtureMatchesTheContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "fixtures", "executor-contract", "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Events []executorEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range fixture.Events {
		if err := event.validate(); err != nil {
			t.Fatalf("%s: %v", event.Type, err)
		}
		// 夹具载荷按控制面规范编码；Worker 重新规范化后摘要必须一致
		var generic any
		_ = json.Unmarshal(event.Payload, &generic)
		if _, sum, err := canonicalPayload(generic); err != nil || sum != event.PayloadSHA256 {
			t.Fatalf("%s: canonical sha mismatch %s vs %s", event.Type, sum, event.PayloadSHA256)
		}
		seen[event.Type] = true
	}
	for kind := range executorEventTypes {
		if !seen[kind] {
			t.Fatalf("fixture lacks event type %s", kind)
		}
	}
	tampered := fixture.Events[0]
	tampered.PayloadSHA256 = "00"
	if tampered.validate() == nil {
		t.Fatal("tampered payload must fail validation")
	}
}

func TestEventValidationRejectsNullPayloadAndBadStream(t *testing.T) {
	raw, sum, _ := canonicalPayload(map[string]any{"a": 1})
	event := executorEvent{EventID: eventID("abc", 1), StreamID: "abc", InstanceID: "gw", Seq: 1, Type: EventProbeRecorded, Version: 1, OccurredAt: "2026-11-05T00:00:00Z", Payload: raw, PayloadSHA256: sum}
	if err := event.validate(); err != nil {
		t.Fatal(err)
	}
	null := event
	null.Payload = []byte("null")
	if null.validate() == nil {
		t.Fatal("null payload must be rejected")
	}
	bad := event
	bad.StreamID, bad.EventID = "a-b", eventID("a-b", 1)
	if bad.validate() == nil {
		t.Fatal("stream ids outside [A-Za-z0-9] must be rejected")
	}
}

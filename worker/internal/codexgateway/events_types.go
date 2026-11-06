package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// 执行契约 v1 的事件（docs/ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md 5.6）。
// 控制面的同一份定义在 src/lib/executor/contract.mjs，二者由 test/fixtures/executor-contract/events.json 对齐。
const (
	executorContractVersion = 1

	// EventRequestFinalized：一次分发的最终结果，载荷与回执相同（含 payload_hash），控制面据此结算
	EventRequestFinalized = "request.finalized"
	// EventAccountState：本实例全部账号的凭据与 BPS 终态快照（整体替换，与心跳 account_credentials 同义）
	EventAccountState = "account.state"
	// EventAccountQuota：有变化的账号额度快照（与心跳 account_quotas 同义）
	EventAccountQuota = "account.quota"
	// EventProbeRecorded：一次 BPS 恢复探测记录（与心跳 bps_probes 的单项同义）
	EventProbeRecorded = "probe.recorded"
)

var executorEventTypes = map[string]bool{
	EventRequestFinalized: true,
	EventAccountState:     true,
	EventAccountQuota:     true,
	EventProbeRecorded:    true,
}

// executorEvent 是事件日志中的一行，也是 GET /internal/v1/events 返回的元素。
type executorEvent struct {
	EventID       string            `json:"event_id"`
	StreamID      string            `json:"stream_id"`
	InstanceID    string            `json:"instance_id"`
	Seq           uint64            `json:"seq"`
	Type          string            `json:"type"`
	Version       int               `json:"version"`
	OccurredAt    string            `json:"occurred_at"`
	Subject       map[string]string `json:"subject,omitempty"`
	Payload       json.RawMessage   `json:"payload"`
	PayloadSHA256 string            `json:"payload_sha256"`
}

func eventID(streamID string, seq uint64) string { return fmt.Sprintf("evt_%s_%d", streamID, seq) }

// canonicalPayload 把载荷编码为按键排序的紧凑 JSON（与回执 payload_hash 及控制面 canonicalJson 同口径）。
func canonicalPayload(value any) (json.RawMessage, string, error) {
	raw, err := marshalJSON(value)
	if err != nil {
		return nil, "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var generic any
	if err := decoder.Decode(&generic); err != nil {
		return nil, "", err
	}
	if raw, err = marshalJSON(generic); err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:]), nil
}

func (e executorEvent) validate() error {
	switch {
	case !validStreamID(e.StreamID) || e.InstanceID == "":
		return errors.New("event stream_id and instance_id are required")
	case e.Seq == 0:
		return errors.New("event seq must be positive")
	case e.EventID != eventID(e.StreamID, e.Seq):
		return errors.New("event_id does not match stream_id and seq")
	case !executorEventTypes[e.Type]:
		return fmt.Errorf("unknown event type %q", e.Type)
	case e.Version != executorContractVersion:
		return fmt.Errorf("unsupported event version %d", e.Version)
	case len(e.Payload) == 0 || string(bytes.TrimSpace(e.Payload)) == "null":
		return errors.New("event payload is required")
	}
	if _, err := time.Parse(time.RFC3339Nano, e.OccurredAt); err != nil {
		return fmt.Errorf("invalid occurred_at: %w", err)
	}
	// 载荷经 HTTP 或夹具传递时可能带格式空白；摘要按紧凑编码计算（键序由产生方规范化）
	var compact bytes.Buffer
	if err := json.Compact(&compact, e.Payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}
	sum := sha256.Sum256(compact.Bytes())
	if hex.EncodeToString(sum[:]) != e.PayloadSHA256 {
		return errors.New("payload_sha256 mismatch")
	}
	return nil
}

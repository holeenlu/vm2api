package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

// eventsRead：GET /internal/v1/events?after=<seq>&limit=<n>（执行契约 5.6）。
func (s *Server) eventsRead(w http.ResponseWriter, r *http.Request) {
	if s.events == nil {
		writeError(w, http.StatusServiceUnavailable, "event_log_unavailable", "event log is unavailable")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use GET")
		return
	}
	query := r.URL.Query()
	after, err := strconv.ParseUint(firstString(query.Get("after"), "0"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_after", "after must be a non-negative integer")
		return
	}
	limit, _ := strconv.Atoi(query.Get("limit"))
	if stream := query.Get("stream_id"); stream != "" && stream != s.events.streamID {
		// 控制面的游标属于另一条流（数据目录已重建）：告知新流，由控制面从 0 开始
		s.writeSignedJSON(w, r, http.StatusConflict, map[string]any{"ok": false, "error": map[string]string{"code": "event_stream_changed", "message": "event stream changed"}, "stream_id": s.events.streamID})
		return
	}
	events, err := s.events.read(after, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "event_read_failed", err.Error())
		return
	}
	status := s.events.status()
	next := after
	if len(events) > 0 {
		next = events[len(events)-1].Seq
	}
	s.writeSignedJSON(w, r, http.StatusOK, map[string]any{"ok": true, "stream_id": status.StreamID, "instance_id": s.cfg.InstanceID, "head": status.Head, "acked": status.Acked, "next": next, "events": events})
}

// writeSignedJSON 给事件页响应签名（P3.11，R1 审查 P2-10）：HMAC 覆盖“resp + 状态码 + 路径、请求随机串、正文摘要、正文”
// （R3 审查 P2-7 加入状态码与路径），用验证本次请求的同一把密钥（实例密钥或共用令牌）签名，控制面验签后才处理；绑定请求随机串，旧响应不能被重放给另一次拉取。
func (s *Server) writeSignedJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	data, err := marshalJSON(value)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode_failed", err.Error())
		return
	}
	hash := BodyHash(data)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Kin-Gateway-Response-Sha256", hash)
	w.Header().Set("X-Kin-Gateway-Response-Signature", Sign(verifiedSecret(r.Context(), s.cfg.InternalToken), responseSignatureScope(status, r.URL.RequestURI()), r.Header.Get("X-Kin-Gateway-Nonce"), hash, data))
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// eventsAck：POST /internal/v1/events/ack {"stream_id","seq"}；重复确认幂等。
func (s *Server) eventsAck(w http.ResponseWriter, r *http.Request) {
	if s.events == nil {
		writeError(w, http.StatusServiceUnavailable, "event_log_unavailable", "event log is unavailable")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use POST")
		return
	}
	var body struct {
		StreamID string `json:"stream_id"`
		Seq      uint64 `json:"seq"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if body.StreamID != s.events.streamID {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": map[string]string{"code": "event_stream_changed", "message": "event stream changed"}, "stream_id": s.events.streamID})
		return
	}
	if err := s.events.ack(body.Seq); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_ack", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stream_id": body.StreamID, "acked": s.events.status().Acked})
}

const eventSnapshotInterval = 10 * time.Second

// eventSnapshotLoop 维护事件日志（故障恢复、未消费时自行确认、清理），并把账号终态与额度的变化写成事件
// （心跳仍并行上报同样的内容；控制面只在事件链路健康时停用心跳中的同类字段）。
func (s *Server) eventSnapshotLoop(ctx context.Context) {
	s.emitStateEvents()
	ticker := time.NewTicker(eventSnapshotInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.emitStateEvents()
		}
	}
}

func (s *Server) emitStateEvents() {
	s.events.maintain()
	items := s.store.credentialStates()
	force := s.events.takeResnapshot()
	if _, sum, err := canonicalPayload(items); err == nil && (force || sum != s.stateEvent) {
		if _, err := s.events.append(EventAccountState, nil, map[string]any{"items": items}); err != nil {
			log.Printf("codex-gateway: account.state event not recorded: %v", err)
			if force {
				s.events.resnapshot.Store(true)
			}
		} else {
			s.stateEvent = sum
		}
	}
	reports, fingerprints := s.quotaEvents.pending(s.store.snapshot())
	if len(reports) == 0 {
		return
	}
	if _, err := s.events.append(EventAccountQuota, nil, map[string]any{"items": reports}); err != nil {
		log.Printf("codex-gateway: account.quota event not recorded: %v", err)
		return
	}
	s.quotaEvents.commit(fingerprints)
}

// responseSignatureScope 是响应签名的域：resp、状态码与完整请求目标（路径与查询串，终审 B3）。
func responseSignatureScope(status int, target string) string {
	return fmt.Sprintf("resp %d %s", status, target)
}

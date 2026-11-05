package codexgateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// 请求诊断事实（对齐 codex-proxy-rs 5100f633 与 transport/diagnostics）：Worker 把结构化上游错误、续接不可用原因、
// 上游 WS 中途断开的关闭码与连接退出原因交给控制面写入使用记录；它们只用于受控诊断，不改变错误分类与交付。
const (
	upstreamErrorHeader      = "X-Kin-Gateway-Upstream-Error"
	continuationReasonHeader = "X-Kin-Gateway-Continuation-Reason"
	// gatewayDiagnosticTrailer 是流式响应结束后交给控制面的诊断 trailer（WS 终态前断开的关闭码与退出原因）
	gatewayDiagnosticTrailer = "X-Kin-Gateway-Diagnostic"
	diagnosticTextLimit      = 1024
)

func truncateDiagnostic(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > diagnosticTextLimit {
		value = value[:diagnosticTextLimit]
	}
	return value
}

// upstreamErrorJSON 投影上游错误对象的 code / type / message / param；都缺失时为空。
func upstreamErrorJSON(failure *upstreamFailure) string {
	if failure == nil {
		return ""
	}
	fields := map[string]string{}
	for key, value := range map[string]string{"code": failure.Code, "type": failure.Type, "message": failure.Message, "param": failure.Param} {
		if value = truncateDiagnostic(value); value != "" && validHeaderValue(value) {
			fields[key] = value
		}
	}
	if len(fields) == 0 {
		return ""
	}
	data, _ := json.Marshal(fields)
	return string(data)
}

// wsCloseDiagnostic 是上游 WS 在终态前断开时的诊断（经 trailer 交给控制面，不进入调用方的流）。
func wsCloseDiagnostic(err error, lastEvent string) []byte {
	event := map[string]any{"last_event_type": lastEvent}
	var closeErr websocket.CloseError
	switch {
	case errors.Is(err, errWSIdle):
		event["connection_exit_reason"] = "stream_idle_timeout"
	case errors.As(err, &closeErr):
		event["connection_exit_reason"] = "closed_by_upstream"
		event["websocket_close_code"] = int(closeErr.Code)
		if reason := truncateDiagnostic(closeErr.Reason); reason != "" {
			event["close_reason"] = reason
		}
	default:
		event["connection_exit_reason"] = "read_error"
	}
	data, _ := json.Marshal(event)
	return data
}

// refreshFailure 是账号最近一次刷新失败的结构化诊断（CPR credential/diagnostics.rs）；成功刷新后清除。
type RefreshFailure struct {
	At        time.Time `json:"at"`
	Operation string    `json:"operation"`
	Status    int       `json:"status,omitempty"`
	Code      string    `json:"code,omitempty"`
	Message   string    `json:"message,omitempty"`
}

// redactRefreshBody 去掉刷新响应里的令牌与凭据字段，再截断为诊断文本。
func redactRefreshBody(body []byte, refreshToken string) string {
	var value any
	if json.Unmarshal(body, &value) == nil {
		value = redactSecrets(value)
		if data, err := json.Marshal(value); err == nil {
			body = data
		}
	}
	text := string(body)
	if refreshToken != "" {
		text = strings.ReplaceAll(text, refreshToken, "[REDACTED]")
	}
	return truncateDiagnostic(text)
}

var secretKeys = map[string]bool{"access_token": true, "refresh_token": true, "id_token": true, "client_secret": true, "authorization": true, "cookie": true}

func redactSecrets(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if secretKeys[strings.ToLower(key)] {
				typed[key] = "[REDACTED]"
			} else {
				typed[key] = redactSecrets(item)
			}
		}
	case []any:
		for i, item := range typed {
			typed[i] = redactSecrets(item)
		}
	}
	return value
}

func (s *Store) SetRefreshFailure(id string, failure *RefreshFailure) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if ok {
		account.LastRefreshFailure = failure
		account.RuntimeRevision++
		s.accounts[id] = account
	}
	s.mu.Unlock()
	if ok {
		s.persistSoon()
	}
}

// upstreamRequestIDs 取上游响应的请求 ID 与 Cloudflare ray，供尝试记录关联上游日志。
func upstreamRequestIDs(header http.Header) (string, string) {
	if header == nil {
		return "", ""
	}
	id := header.Get("x-request-id")
	if id == "" {
		id = header.Get("x-oai-request-id")
	}
	return truncateDiagnostic(id), truncateDiagnostic(header.Get("cf-ray"))
}

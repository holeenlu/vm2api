package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/klauspost/compress/zstd"
)

var (
	zstdOnce    sync.Once
	zstdEncoder *zstd.Encoder
	zstdErr     error
)

// zstdEncode 与 CPR 相同使用默认级别（level 3）压缩 OAuth 推理正文。
func zstdEncode(data []byte) ([]byte, error) {
	zstdOnce.Do(func() {
		zstdEncoder, zstdErr = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))
	})
	if zstdErr != nil {
		return nil, zstdErr
	}
	return zstdEncoder.EncodeAll(data, nil), nil
}

// 关联 ID 隔离（对齐 codex-proxy-rs transport/correlation.rs）：会话、线程、窗口等引用与
// prompt_cache_key 按账号 installation id 映射为稳定 UUID，同一原值在同一账号下等值；
// turn_id 与轮次引用保留原值；trace 字段（traceparent、tracestate、sentry-trace、baggage 及 WS 副本）
// 与 CPR 一致原样透传。只改出站副本，不影响本地亲和与续接。
var (
	correlationIDFields = []string{"session_id", "thread_id", "window_id", "context_window_id", "parent_thread_id", "forked_from_thread_id", "conversation_id", "x-codex-window-id", "x-codex-parent-thread-id", "x-client-request-id", "codexWindowId", "parentThreadId"}
	correlationMetadata = []string{"turnMetadata", "turn_metadata", "x-codex-turn-metadata"}
	correlationHeaders  = []string{"session-id", "thread-id", "x-codex-window-id", "x-codex-parent-thread-id", "x-client-request-id"}
)

func scopedID(installationID, original string) string {
	sum := sha256.Sum256([]byte("codex-account-correlation-v1\x00" + installationID + "\x00" + original))
	b := sum[:16]
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// scopeCorrelationHeaders 映射关联头。
func scopeCorrelationHeaders(header http.Header, installationID string) {
	if installationID != "" {
		for _, name := range correlationHeaders {
			if value := header.Get(name); value != "" {
				header.Set(name, scopedID(installationID, value))
			}
		}
	}
	if raw := header.Get("x-codex-turn-metadata"); raw != "" {
		if scoped, ok := scopeMetadataString(raw, installationID); ok {
			header.Set("x-codex-turn-metadata", scoped)
		}
	}
}

// scopeCorrelationBody 按原字段顺序改写请求正文；无法解析时原样返回。
func scopeCorrelationBody(body []byte, installationID string) []byte {
	out, changed, err := rewriteObject(body, func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		return scopeTopLevel(key, value, installationID)
	})
	if err != nil || !changed {
		return body
	}
	return out
}

// scopeTopLevel 返回 (新值, 是否删除, 是否改变)。
func scopeTopLevel(key string, value json.RawMessage, installationID string) (json.RawMessage, bool, bool) {
	if installationID != "" && (containsString(correlationIDFields, key) || key == "prompt_cache_key") {
		if mapped, ok := mapStringValue(value, installationID); ok {
			return mapped, false, true
		}
	}
	if containsString(correlationMetadata, key) {
		if mapped, ok := scopeMetadataValue(value, installationID); ok {
			return mapped, false, true
		}
	}
	if key == "client_metadata" {
		mapped, changed, err := rewriteObject(value, func(inner string, innerValue json.RawMessage) (json.RawMessage, bool, bool) {
			if installationID != "" && containsString(correlationIDFields, inner) {
				if out, ok := mapStringValue(innerValue, installationID); ok {
					return out, false, true
				}
			}
			if containsString(correlationMetadata, inner) {
				if out, ok := scopeMetadataValue(innerValue, installationID); ok {
					return out, false, true
				}
			}
			return innerValue, false, false
		})
		if err == nil && changed {
			return mapped, false, true
		}
	}
	return value, false, false
}

func mapStringValue(value json.RawMessage, installationID string) (json.RawMessage, bool) {
	var text string
	if json.Unmarshal(value, &text) != nil || text == "" {
		return nil, false
	}
	out, _ := json.Marshal(scopedID(installationID, text))
	return out, true
}

// scopeMetadataValue 处理 turn metadata：对象直接改写，JSON 字符串解析后改写再编码回 ASCII 字符串。
func scopeMetadataValue(value json.RawMessage, installationID string) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		out, changed, err := rewriteObject(value, func(key string, inner json.RawMessage) (json.RawMessage, bool, bool) {
			return scopeMetadataField(key, inner, installationID)
		})
		return out, err == nil && changed
	}
	var raw string
	if json.Unmarshal(value, &raw) != nil {
		return nil, false
	}
	scoped, ok := scopeMetadataString(raw, installationID)
	if !ok {
		return nil, false
	}
	out, _ := json.Marshal(scoped)
	return out, true
}

func scopeMetadataField(key string, value json.RawMessage, installationID string) (json.RawMessage, bool, bool) {
	if installationID != "" && containsString(correlationIDFields, key) {
		if out, ok := mapStringValue(value, installationID); ok {
			return out, false, true
		}
	}
	return value, false, false
}

func scopeMetadataString(raw, installationID string) (string, bool) {
	out, changed, err := rewriteObject([]byte(raw), func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		return scopeMetadataField(key, value, installationID)
	})
	if err != nil || !changed {
		return "", false
	}
	return asciiJSON(out), true
}

// asciiJSON 把非 ASCII 字符转义，保证可以放进 HTTP 头（官方 serialize_ascii_turn_metadata 同理）。
func asciiJSON(data []byte) string {
	var b strings.Builder
	for _, r := range string(data) {
		if r < 0x80 {
			b.WriteRune(r)
			continue
		}
		if r > 0xffff {
			r -= 0x10000
			fmt.Fprintf(&b, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
			continue
		}
		fmt.Fprintf(&b, `\u%04x`, r)
	}
	return b.String()
}

// rewriteObject 逐字段改写 JSON 对象并保留字段顺序；fn 返回 (新值, 删除, 改变)。
func rewriteObject(data []byte, fn func(string, json.RawMessage) (json.RawMessage, bool, bool)) ([]byte, bool, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, false, err
	}
	if token != json.Delim('{') {
		return nil, false, fmt.Errorf("not a JSON object")
	}
	var out bytes.Buffer
	out.WriteByte('{')
	first, changed := true, false
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false, err
		}
		key, _ := token.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false, err
		}
		next, drop, did := fn(key, value)
		if did {
			changed = true
		}
		if drop {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(next)
	}
	out.WriteByte('}')
	return out.Bytes(), changed, nil
}

// requestKind 识别 compact 请求（CPR：request_kind=compaction 或输入含 compaction_trigger），只用于观测。
func requestKind(body []byte) string {
	var probe struct {
		RequestKind string            `json:"request_kind"`
		Input       []json.RawMessage `json:"input"`
	}
	if json.Unmarshal(body, &probe) != nil {
		return ""
	}
	if strings.EqualFold(probe.RequestKind, "compaction") {
		return "compaction"
	}
	for _, item := range probe.Input {
		var typed struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(item, &typed) == nil && typed.Type == "compaction_trigger" {
			return "compaction"
		}
	}
	return ""
}

// codexRoutingHint 按实际上游正文生成 x-codex-routing-hint（CPR headers.rs）：model=<m>，带 service_tier 时追加 ;tier=<t>。
func codexRoutingHint(body []byte) string {
	var fields struct {
		Model       string `json:"model"`
		ServiceTier string `json:"service_tier"`
	}
	if json.Unmarshal(body, &fields) != nil || strings.TrimSpace(fields.Model) == "" {
		return ""
	}
	if fields.ServiceTier != "" {
		return "model=" + fields.Model + ";tier=" + fields.ServiceTier
	}
	return "model=" + fields.Model
}

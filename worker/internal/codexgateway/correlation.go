package codexgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
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

// scopeSearchBody 对齐 CPR scope_search_body：独立搜索正文只把顶层 id（会话关联键）按账号映射，
// 其余字段原样转发。/alpha/search 按固定契约校验参数，追加 client_metadata 等 Responses 字段会被 400 拒绝。
func scopeSearchBody(body []byte, installationID string) []byte {
	if installationID == "" {
		return body
	}
	out, changed, err := rewriteObject(body, func(key string, value json.RawMessage) (json.RawMessage, bool, bool) {
		if key != "id" {
			return value, false, false
		}
		mapped, ok := mapStringValue(value, installationID)
		if !ok {
			return value, false, false
		}
		return mapped, false, true
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
// walkObject 按顺序遍历 JSON 对象的顶层成员，visit 返回 false 时提前结束。成员值按原始字节给出，
// 只做结构扫描（字符串转义与括号配对）界定边界，不对未用到的大字段（如多 MB 的 input 历史）做完整解析；
// 正文来自控制面的 JSON 序列化，值的语义由调用方按需解析。
func walkObject(data []byte, visit func(key string, value json.RawMessage) bool) error {
	i := skipJSONSpace(data, 0)
	if i >= len(data) || data[i] != '{' {
		return fmt.Errorf("not a JSON object")
	}
	i = skipJSONSpace(data, i+1)
	if i < len(data) && data[i] == '}' {
		return nil
	}
	for {
		if i >= len(data) || data[i] != '"' {
			return errInvalidJSONObject
		}
		keyEnd, err := scanJSONString(data, i)
		if err != nil {
			return err
		}
		var key string
		if err := json.Unmarshal(data[i:keyEnd], &key); err != nil {
			return err
		}
		i = skipJSONSpace(data, keyEnd)
		if i >= len(data) || data[i] != ':' {
			return errInvalidJSONObject
		}
		i = skipJSONSpace(data, i+1)
		valueEnd, err := scanJSONValue(data, i)
		if err != nil {
			return err
		}
		if !visit(key, json.RawMessage(data[i:valueEnd])) {
			return nil
		}
		i = skipJSONSpace(data, valueEnd)
		if i < len(data) && data[i] == ',' {
			i = skipJSONSpace(data, i+1)
			continue
		}
		if i < len(data) && data[i] == '}' {
			return nil
		}
		return errInvalidJSONObject
	}
}

// rewriteObject 逐个改写 JSON 对象的顶层成员：fn 返回新值、是否删除、是否改动。未改动的成员按原始字节透传，
// 输出与 encoding/json 逐成员重写的结果逐字节相同。
func rewriteObject(data []byte, fn func(string, json.RawMessage) (json.RawMessage, bool, bool)) ([]byte, bool, error) {
	var out bytes.Buffer
	out.Grow(len(data) + 64)
	out.WriteByte('{')
	first, changed := true, false
	err := walkObject(data, func(key string, value json.RawMessage) bool {
		next, drop, did := fn(key, value)
		if did {
			changed = true
		}
		if drop {
			return true
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(next)
		return true
	})
	if err != nil {
		return nil, false, err
	}
	out.WriteByte('}')
	return out.Bytes(), changed, nil
}

// topLevelSubset 只扫描一遍对象顶层，返回仅含指定成员的 JSON 对象（同名成员取最后一个，与 encoding/json 一致），
// 供只读取少数顶层字段的判定使用，避免为此完整解析整个请求正文。正文不是合法对象时返回 nil。
func topLevelSubset(body []byte, keys ...string) []byte {
	picked := map[string]json.RawMessage{}
	if walkObject(body, func(key string, value json.RawMessage) bool {
		for _, want := range keys {
			if key == want {
				picked[key] = value
			}
		}
		return true
	}) != nil {
		return nil
	}
	var out bytes.Buffer
	out.WriteByte('{')
	for _, key := range keys {
		value, ok := picked[key]
		if !ok {
			continue
		}
		if out.Len() > 1 {
			out.WriteByte(',')
		}
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(value)
	}
	out.WriteByte('}')
	return out.Bytes()
}

var errInvalidJSONObject = errors.New("invalid JSON object")

func skipJSONSpace(data []byte, i int) int {
	for i < len(data) && (data[i] == ' ' || data[i] == '\t' || data[i] == '\n' || data[i] == '\r') {
		i++
	}
	return i
}

// scanJSONString 返回从 data[i]（引号）开始的 JSON 字符串结束位置（含结尾引号）。
func scanJSONString(data []byte, i int) (int, error) {
	for j := i + 1; j < len(data); j++ {
		switch data[j] {
		case '\\':
			j++
		case '"':
			return j + 1, nil
		}
	}
	return 0, errInvalidJSONObject
}

// scanJSONValue 返回从 data[i] 开始的一个 JSON 值的结束位置：字符串按转义扫描，对象与数组按括号配对，
// 其余（数字、true、false、null）到下一个分隔符为止。
func scanJSONValue(data []byte, i int) (int, error) {
	if i >= len(data) {
		return 0, errInvalidJSONObject
	}
	switch data[i] {
	case '"':
		return scanJSONString(data, i)
	case '{', '[':
		stack := make([]byte, 0, 16)
		for j := i; j < len(data); j++ {
			switch c := data[j]; c {
			case '"':
				end, err := scanJSONString(data, j)
				if err != nil {
					return 0, err
				}
				j = end - 1
			case '{':
				stack = append(stack, '}')
			case '[':
				stack = append(stack, ']')
			case '}', ']':
				if len(stack) == 0 || stack[len(stack)-1] != c {
					return 0, errInvalidJSONObject
				}
				stack = stack[:len(stack)-1]
				if len(stack) == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, errInvalidJSONObject
	default:
		j := i
		for j < len(data) {
			c := data[j]
			if c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
				break
			}
			j++
		}
		if j == i {
			return 0, errInvalidJSONObject
		}
		return j, nil
	}
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
	if json.Unmarshal(topLevelSubset(body, "model", "service_tier"), &fields) != nil || strings.TrimSpace(fields.Model) == "" {
		return ""
	}
	if fields.ServiceTier != "" {
		return "model=" + fields.Model + ";tier=" + fields.ServiceTier
	}
	return "model=" + fields.Model
}

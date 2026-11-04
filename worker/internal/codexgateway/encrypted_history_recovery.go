package codexgateway

import (
	"regexp"
	"strings"
)

// 密文历史被拒恢复（对齐 sub2api openai_encrypted_history_recovery.go，2026-11-05 用户确认原生通道也启用）：
// 加密推理、压缩与输出回放密文只有签发它的账号能读取。会话换号后（容量换号、签发账号冷却或不在范围、
// 历史来自本网关之外），上游在生成前以 invalid_encrypted_content 拒绝整段历史，客户端会反复重发同一段
// 历史而一直失败（生产 11-04：两个会话分别连续被拒 9 次与 11 次）。恢复只在生成前的拒绝上进行，同一账号、
// 每步一次，逐级缩减：
//
//  1. 去掉带密文的 reasoning 项（没有密文就没有可用内容），并去掉 assistant 消息与工具调用上的输出回放密文
//     （明文保留）；
//  2. 仍被拒，或拒绝点名的是 compaction 时，把每个 compaction 换成一条说明。compaction 是它所概括内容的
//     唯一副本，只有确认不可读时才替换。
//
// 模型失去被去掉的隐藏上下文，可见的消息、调用与输出都保留。带 previous_response_id 的请求不恢复：
// 被拒的状态不在本请求正文里。BPS 通道沿用其既有规则（不重试），不经过这里。
const (
	encryptedHistoryMaxRecoveries = 2
	omittedCompactionNotice       = "[Earlier conversation summary omitted: it was produced by another account and cannot be read here. Messages that are still present above and below remain available.]"
)

var encryptedContentItemPattern = regexp.MustCompile(`(?i)encrypted content for item ['"]?([^\s'"]+?)['"]? could not be verified`)

// nativeHistoryOwner 返回原生选号应优先回到的密文签发账号；BPS 阶段与续接钉号不使用。
func (d *dispatchRun) nativeHistoryOwner(useBPS bool) string {
	if useBPS || d.pinned() {
		return ""
	}
	return d.historyOwner
}

// encryptedHistoryRejected 判断上游是否因读不了历史密文而拒绝（HTTP 错误体或流内 response.failed / error）。
func encryptedHistoryRejected(failure upstreamFailure) bool {
	code := strings.ToLower(strings.TrimSpace(failure.Code))
	switch code {
	case "invalid_encrypted_content", "invalid_compaction", "compaction_decode_error":
		return true
	case "", "thinking_signature_invalid":
	default:
		return false
	}
	message := strings.ToLower(strings.TrimSpace(failure.Message))
	return strings.HasPrefix(message, "the encrypted content ") && strings.Contains(message, "could not be verified")
}

// recoverEncryptedHistory 在生成前的密文拒绝后缩减 d.body，返回 true 表示应在同一账号重发。
func (d *dispatchRun) recoverEncryptedHistory(failure upstreamFailure) bool {
	if d.bpsAttempt || d.pinned() || d.encryptedRecoveries >= encryptedHistoryMaxRecoveries || !encryptedHistoryRejected(failure) {
		return false
	}
	reduced, ok := reduceEncryptedHistory(d.body, d.encryptedRecoveries > 0 || compactionRejected(d.body, failure))
	if !ok && d.encryptedRecoveries == 0 {
		// 第一步没有可去掉的推理或回放密文：直接做第二步
		reduced, ok = reduceEncryptedHistory(d.body, true)
	}
	if !ok {
		return false
	}
	d.body = reduced
	d.encryptedRecoveries++
	return true
}

// reduceEncryptedHistory 去掉 input 中读不了的密文；compactions 为 true 时同时替换 compaction。
// 正文以保序 JSON 改写，其余字段与顺序不变；带 previous_response_id、无法解析或没有可缩减内容时返回 false。
func reduceEncryptedHistory(body []byte, compactions bool) ([]byte, bool) {
	value, err := decodeOrdered(body)
	if err != nil {
		return body, false
	}
	root, ok := value.(*orderedObject)
	if !ok {
		return body, false
	}
	if previous, _ := root.get("previous_response_id"); previous != nil {
		if text, _ := previous.(string); strings.TrimSpace(text) != "" {
			return body, false
		}
	}
	raw, _ := root.get("input")
	items, ok := raw.([]any)
	if !ok {
		return body, false
	}
	reduced := make([]any, 0, len(items))
	changed := false
	for _, entry := range items {
		item, ok := entry.(*orderedObject)
		if !ok || !itemCarriesCiphertext(item) {
			reduced = append(reduced, entry)
			continue
		}
		kind := historyItemType(item)
		switch {
		case kind == "reasoning":
			changed = true
		case isCompactionItem(kind):
			if !compactions {
				reduced = append(reduced, entry)
				continue
			}
			changed = true
			reduced = append(reduced, compactionNoticeMessage())
		case replayCiphertextItem(item, kind):
			plain := cloneOrdered(item).(*orderedObject)
			plain.remove("encrypted_content")
			changed = true
			reduced = append(reduced, plain)
		default:
			reduced = append(reduced, entry)
		}
	}
	if !changed {
		return body, false
	}
	root.set("input", reduced)
	out, err := encodeOrdered(root)
	if err != nil {
		return body, false
	}
	return out, true
}

// compactionRejected：拒绝点名的项是 compaction（或错误码本身指向 compaction）时第一步就替换它。
func compactionRejected(body []byte, failure upstreamFailure) bool {
	code := strings.ToLower(strings.TrimSpace(failure.Code))
	if code == "invalid_compaction" || code == "compaction_decode_error" {
		return true
	}
	match := encryptedContentItemPattern.FindStringSubmatch(failure.Message)
	if len(match) != 2 {
		return false
	}
	value, err := decodeOrdered(body)
	if err != nil {
		return false
	}
	root, ok := value.(*orderedObject)
	if !ok {
		return false
	}
	raw, _ := root.get("input")
	items, _ := raw.([]any)
	for _, entry := range items {
		if item, ok := entry.(*orderedObject); ok && stringField(item, "id") == match[1] && isCompactionItem(historyItemType(item)) {
			return true
		}
	}
	return false
}

func itemCarriesCiphertext(item *orderedObject) bool {
	return stringField(item, "encrypted_content") != ""
}

func historyItemType(item *orderedObject) string {
	kind := stringField(item, "type")
	if kind == "" {
		if _, ok := item.get("role"); ok {
			return "message"
		}
	}
	return kind
}

func isCompactionItem(kind string) bool {
	return kind == "compaction" || kind == "compaction_summary" || kind == "context_compaction"
}

// replayCiphertextItem：输出回放密文挂在仍保留明文的 assistant 消息与工具调用上。
func replayCiphertextItem(item *orderedObject, kind string) bool {
	switch kind {
	case "message":
		return stringField(item, "role") == "assistant"
	case "function_call", "custom_tool_call", "web_search_call", "image_generation_call", "local_shell_call", "tool_search_call":
		return true
	}
	return false
}

func compactionNoticeMessage() *orderedObject {
	part := newOrderedObject()
	part.set("type", "input_text")
	part.set("text", omittedCompactionNotice)
	message := newOrderedObject()
	message.set("type", "message")
	message.set("role", "developer")
	message.set("content", []any{part})
	return message
}

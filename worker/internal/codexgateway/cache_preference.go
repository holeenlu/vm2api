package codexgateway

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strings"
)

// 无会话请求的内容亲和（对齐 codex-proxy-rs e3904178、1240f225 derive_cache_preference）：
// 客户端没有任何会话标识时，用调用方显式给出的 prompt_cache_key，否则用开头消息（模型、instructions、
// 开头的 system/developer 消息与第一条 user 消息）的摘要，在调用方范围内偏向同一账号以保住上游提示缓存。
// 它只参与选号绑定，按配置的亲和模式处理：优先模式忙时可分流，严格模式排队等待，宽松模式不启用；
// 不是会话、轮次、续接或传输身份。只用于 responses/chat；已有会话、后代线程、续接、Guardian、指定账号和没有调用方范围的请求都不生成。

const (
	clientCachePreference = "client-cache-preference"
	contentPreference     = "content-preference"
)

func (d *dispatchRun) deriveCachePreference(body map[string]any) string {
	if (d.envelope.Operation != "responses" && d.envelope.Operation != "chat") || d.envelope.ClientScope == "" || d.envelope.Scope.SessionID != "" || d.envelope.Scope.RuntimeAccountID != "" ||
		d.guardian || d.followOnly || d.envelope.Scheduling.affinity() == "relaxed" {
		return ""
	}
	if previous, _ := body["previous_response_id"].(string); strings.TrimSpace(previous) != "" {
		return ""
	}
	header, metadata, turn, text := clientIdentityParts(d.envelope.Headers, body)
	if text(turn["session_id"], metadata["session_id"], header("session-id"), body["session_id"]) != "" {
		return ""
	}
	if key, _ := body["prompt_cache_key"].(string); strings.TrimSpace(key) != "" {
		return cachePreferenceKey(clientCachePreference, strings.TrimSpace(key))
	}
	hash := sha256.New()
	hashTextField(hash, []string{text(body["model"])})
	instructions, _ := body["instructions"].(string)
	hashTextField(hash, []string{instructions})
	var items []any
	switch input := body["input"].(type) {
	case []any:
		items = input
	case string:
		// 字符串输入等价于一条 user 消息
		items = []any{map[string]any{"role": "user", "content": input}}
	}
	index := 0
	for ; index < len(items); index++ {
		item, _ := items[index].(map[string]any)
		if role, _ := item["role"].(string); role != "system" && role != "developer" {
			break
		}
		hashTextField(hash, messageTextParts(item))
	}
	if index >= len(items) {
		return ""
	}
	first, _ := items[index].(map[string]any)
	if role, _ := first["role"].(string); role != "user" || !hashTextField(hash, messageTextParts(first)) {
		return ""
	}
	return cachePreferenceKey(contentPreference, hex.EncodeToString(hash.Sum(nil)))
}

func cachePreferenceKey(source, anchor string) string {
	sum := sha256.Sum256([]byte(source + "\x00" + anchor))
	return "cache-preference\x00" + source + "\x00" + hex.EncodeToString(sum[:])
}

// messageTextParts 同时接受简写字符串与 Responses 文本块（input_text），忽略图片等非文本部分。
func messageTextParts(item map[string]any) []string {
	switch content := item["content"].(type) {
	case string:
		return []string{content}
	case []any:
		var parts []string
		for _, raw := range content {
			part, _ := raw.(map[string]any)
			if kind, _ := part["type"].(string); kind != "input_text" {
				continue
			}
			if text, ok := part["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return parts
	}
	return nil
}

// hashTextField 以长度前缀区分字段边界；全为空白时不写入并返回 false。
func hashTextField(hash interface{ Write([]byte) (int, error) }, parts []string) bool {
	blank, length := true, 0
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			blank = false
		}
		length += len(part)
	}
	if blank {
		return false
	}
	var prefix [8]byte
	binary.BigEndian.PutUint64(prefix[:], uint64(length))
	_, _ = hash.Write(prefix[:])
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
	}
	return true
}

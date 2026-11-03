package codexgateway

import "bytes"

// 选定 OAuth（Codex 后端）账号后的请求兼容（对齐 codex-proxy-rs compat/request.rs、search_history.rs）：
//   - 历史 reasoning 项去掉 SDK 输出才有的 status；已有加密内容时去掉冗余的明文 content；
//   - 历史含 web_search_call 而本轮未声明搜索工具时补声明（openai/codex#51962，Codex 0.163 本地压缩
//     会保留搜索历史却清空工具，上游返回 500）。Lite 请求追加独立的 additional_tools 项，不改历史项。
//
// 只处理请求事实，不改业务正文其他部分；无法解析或结构不符时原样发送。
func normalizeCodexOAuthBody(body []byte, responsesLite bool) []byte {
	if !bytes.Contains(body, []byte(`"reasoning"`)) && !bytes.Contains(body, []byte(`web_search_call`)) {
		return body
	}
	value, err := decodeOrdered(body)
	if err != nil {
		return body
	}
	root, ok := value.(*orderedObject)
	if !ok {
		return body
	}
	changed := normalizeReasoningHistory(root)
	changed = normalizeSearchHistory(root, responsesLite) || changed
	if !changed {
		return body
	}
	out, err := encodeOrdered(root)
	if err != nil {
		return body
	}
	return out
}

func normalizeReasoningHistory(root *orderedObject) bool {
	input, _ := root.values["input"].([]any)
	changed := false
	for _, raw := range input {
		item, ok := raw.(*orderedObject)
		if !ok || stringField(item, "type") != "reasoning" {
			continue
		}
		if _, ok := item.values["status"]; ok {
			item.remove("status")
			changed = true
		}
		// Codex 只接受空 content；仅在加密历史仍可回填时去掉明文，没有加密内容的历史交给上游判定
		encrypted, _ := item.values["encrypted_content"].(string)
		if content, ok := item.values["content"].([]any); ok && len(content) > 0 && len(bytes.TrimSpace([]byte(encrypted))) > 0 {
			item.remove("content")
			changed = true
		}
	}
	return changed
}

func toolsDeclareSearch(tools []any) bool {
	for _, raw := range tools {
		tool, ok := raw.(*orderedObject)
		if !ok {
			continue
		}
		kind := stringField(tool, "type")
		if kind == "web_search" || len(kind) >= len("web_search_preview") && kind[:len("web_search_preview")] == "web_search_preview" {
			return true
		}
	}
	return false
}

func normalizeSearchHistory(root *orderedObject, lite bool) bool {
	// 原生续接的历史声明可能只在上游连接中，不能从本轮增量推断工具缺失
	if previous, ok := root.values["previous_response_id"]; ok && previous != nil {
		return false
	}
	input, ok := root.values["input"].([]any)
	if !ok {
		return false
	}
	hasSearchCall := false
	for _, raw := range input {
		if item, ok := raw.(*orderedObject); ok && stringField(item, "type") == "web_search_call" {
			hasSearchCall = true
			break
		}
	}
	if !hasSearchCall {
		return false
	}
	var tools []any
	switch value := root.values["tools"].(type) {
	case nil:
	case []any:
		tools = value
	default:
		return false
	}
	if toolsDeclareSearch(tools) {
		return false
	}
	hasTools := len(tools) > 0
	for _, raw := range input {
		item, ok := raw.(*orderedObject)
		if !ok {
			continue
		}
		if kind := stringField(item, "type"); kind == "additional_tools" || kind == "tool_search_output" {
			declared, ok := item.values["tools"].([]any)
			if !ok {
				// 不修补非法工具结构，保留上游原有校验
				return false
			}
			if toolsDeclareSearch(declared) {
				return false
			}
			hasTools = hasTools || len(declared) > 0
		}
	}
	disableTools := !hasTools
	if disableTools {
		if choice, ok := root.values["tool_choice"]; ok && choice != nil {
			if text, _ := choice.(string); text != "auto" && text != "none" {
				return false
			}
		}
	}
	tool := newOrderedObject()
	tool.set("type", "web_search")
	tool.set("external_web_access", false)
	if lite {
		insertAt := len(input)
		if last, ok := input[len(input)-1].(*orderedObject); ok && stringField(last, "type") == "compaction_trigger" {
			insertAt--
		}
		declaration := newOrderedObject()
		declaration.set("type", "additional_tools")
		declaration.set("role", "developer")
		declaration.set("tools", []any{tool})
		next := append(append(append([]any{}, input[:insertAt]...), declaration), input[insertAt:]...)
		root.values["input"] = next
	} else {
		root.set("tools", append(append([]any{}, tools...), tool))
	}
	// 无工具请求只获得历史解释声明；已有工具时保留调用方的工具选择，新增搜索仅可读缓存
	if disableTools {
		root.set("tool_choice", "none")
	}
	return true
}

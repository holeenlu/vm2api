package codexgateway

import "bytes"

// 选定 OAuth（Codex 后端）账号后的请求兼容（对齐 codex-proxy-rs compat/request.rs、search_history.rs）：
//   - 缺少 store 时补 false（CPR normalize_codex_request_body：官方 Core/Desktop 显式发送 store=false，
//     Codex 后端对缺省的请求返回 400 “Store must be set to false”）；显式值保留，交给上游判定；
//   - 去掉 Codex OAuth 后端拒绝的客户端选项（CPR 55526973 normalize_codex_oauth_options）：采样与身份类字段、
//     stream_options.include_usage、无实际效果的 truncation/stop_sequences/prompt_cache_options；
//     Chat 的 max_completion_tokens / max_tokens 只在没有原生 max_output_tokens 时补为 max_output_tokens；
//   - 历史 reasoning 项去掉 SDK 输出才有的 status；已有加密内容时去掉冗余的明文 content；
//   - 历史含 web_search_call 而本轮未声明搜索工具时补声明（openai/codex#51962，Codex 0.163 本地压缩
//     会保留搜索历史却清空工具，上游返回 500）。Lite 请求追加独立的 additional_tools 项，不改历史项。
//
// 只处理请求事实，不改业务正文其他部分；无法解析或结构不符时原样发送。
func normalizeCodexOAuthBody(body []byte, responsesLite bool) []byte {
	missingStore := len(topLevelSubset(body, "store")) == len("{}")
	if !missingStore && !bytes.Contains(body, []byte(`"reasoning"`)) && !bytes.Contains(body, []byte(`web_search_call`)) &&
		!mentionsOAuthOption(body) {
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
	changed := false
	if _, ok := root.get("store"); !ok {
		root.set("store", false)
		changed = true
	}
	changed = normalizeOAuthOptions(root) || changed
	changed = normalizeReasoningHistory(root) || changed
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

// Codex OAuth 后端拒绝这些选项，即使取默认值；不在表内的字段（包括 client_metadata、工具参数里的同名属性）不动
var oauthRejectedOptions = []string{
	"top_p", "frequency_penalty", "presence_penalty", "chat_template_kwargs", "user", "metadata", "safety_identifier",
}

var oauthOptionNames = append(append([]string{}, oauthRejectedOptions...),
	"stream_options", "truncation", "stop_sequences", "prompt_cache_options", "max_completion_tokens", "max_tokens")

// 粗筛：正文里没有任何相关字段名就不必解析；命中只是进入精确判断
func mentionsOAuthOption(body []byte) bool {
	for _, name := range oauthOptionNames {
		if bytes.Contains(body, []byte(`"`+name+`"`)) {
			return true
		}
	}
	return false
}

func normalizeOAuthOptions(root *orderedObject) bool {
	changed := false
	for _, field := range oauthRejectedOptions {
		if _, ok := root.values[field]; ok {
			root.remove(field)
			changed = true
		}
	}
	// Responses 自带用量；保留官方流式推理摘要等其他选项
	if options, ok := root.values["stream_options"].(*orderedObject); ok {
		if _, has := options.values["include_usage"]; has {
			options.remove("include_usage")
			changed = true
		}
	}
	// 只省略没有实际效果的配置，不静默取消客户端要求的截断、停止条件或缓存策略
	if truncation, _ := root.values["truncation"].(string); truncation == "disabled" {
		root.remove("truncation")
		changed = true
	}
	if stop, ok := root.values["stop_sequences"].([]any); ok && len(stop) == 0 {
		root.remove("stop_sequences")
		changed = true
	}
	if options, ok := root.values["prompt_cache_options"].(*orderedObject); ok && len(options.values) == 0 {
		root.remove("prompt_cache_options")
		changed = true
	}
	// 原生上限优先，Chat 别名只补缺，非法值仍交给上游校验
	for _, alias := range []string{"max_completion_tokens", "max_tokens"} {
		limit, ok := root.values[alias]
		if !ok {
			continue
		}
		root.remove(alias)
		changed = true
		if limit == nil {
			continue
		}
		if native, has := root.values["max_output_tokens"]; !has || native == nil {
			root.set("max_output_tokens", limit)
		}
	}
	return changed
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

// rawToolsDeclareSearch 判断原始 tools 数组是否声明托管搜索；非数组或无法解析视为未声明。
func rawToolsDeclareSearch(raw []byte) bool {
	if !bytes.Contains(raw, []byte(`web_search`)) {
		return false
	}
	value, err := decodeOrdered(raw)
	if err != nil {
		return false
	}
	tools, _ := value.([]any)
	return toolsDeclareSearch(tools)
}

// rawInputDeclaresSearch 识别 Responses Lite 在 input 中以 additional_tools / tool_search_output
// 携带的托管搜索声明（对齐 codex-proxy-rs compat/search_tools.rs declares_hosted_search）。
func rawInputDeclaresSearch(raw []byte) bool {
	if !bytes.Contains(raw, []byte(`web_search`)) ||
		(!bytes.Contains(raw, []byte(`additional_tools`)) && !bytes.Contains(raw, []byte(`tool_search_output`))) {
		return false
	}
	value, err := decodeOrdered(raw)
	if err != nil {
		return false
	}
	input, _ := value.([]any)
	for _, entry := range input {
		item, ok := entry.(*orderedObject)
		if !ok {
			continue
		}
		if kind := stringField(item, "type"); kind != "additional_tools" && kind != "tool_search_output" {
			continue
		}
		if tools, ok := item.values["tools"].([]any); ok && toolsDeclareSearch(tools) {
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

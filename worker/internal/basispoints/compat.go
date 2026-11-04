package basispoints

import (
	"bufio"
	"bytes"
	"strings"
)

// 以下三个辅助函数随协议包从 sub2api 一并移植（原位于 internal/pkg/openai 与 internal/gateway/protocol/sse），
// 协议包不依赖 Worker 其他包。

// isContextWindowErrorText reports whether any value reads as an upstream
// "context window exhausted" error. Matched text is used for classification only, never echoed.
func isContextWindowErrorText(values ...string) bool {
	for _, value := range values {
		lower := strings.ToLower(strings.TrimSpace(value))
		if lower == "" {
			continue
		}
		if strings.Contains(lower, "context_too_large") || strings.Contains(lower, "context_length_exceeded") {
			return true
		}
		if strings.Contains(lower, "maximum context length") || strings.Contains(lower, "max context length") {
			return true
		}
		exceeded := strings.Contains(lower, "exceed") || strings.Contains(lower, "too large") || strings.Contains(lower, "too long")
		if (strings.Contains(lower, "context window") || strings.Contains(lower, "context length")) && exceeded {
			return true
		}
		if strings.Contains(lower, "token limit") && strings.Contains(lower, "context") && exceeded {
			return true
		}
	}
	return false
}

// isNamedStandaloneToolOutput recognizes the existing Codex external-input form.
// It describes supplied context, not proof that a tool call was executed.
func isNamedStandaloneToolOutput(item map[string]any) bool {
	kind, _ := item["type"].(string)
	id, _ := item["call_id"].(string)
	name, _ := item["name"].(string)
	return strings.TrimSpace(kind) == "function_call_output" && strings.TrimSpace(id) == "" && strings.TrimSpace(name) != ""
}

// scanSSELines returns a bufio.SplitFunc for SSE lines. SSE has three line
// endings: CR, LF and CRLF. A CR is consumed immediately and its optional LF
// is swallowed on the next call, so a live CR-only stream does not wait for
// EOF. A UTF-8 BOM before the first line is dropped. The returned function is
// stateful; use one per scanner.
func scanSSELines() bufio.SplitFunc {
	first, afterCR := true, false
	scanned := 0
	return func(data []byte, atEOF bool) (int, []byte, error) {
		offset := 0
		if afterCR && len(data) > 0 {
			afterCR = false
			if data[0] == '\n' {
				offset, data = 1, data[1:]
			}
		}
		i := bytes.IndexAny(data[scanned:], "\r\n")
		if i >= 0 {
			i += scanned
		}
		if i < 0 && !atEOF {
			scanned = len(data)
			return offset, nil, nil
		}
		if i < 0 && len(data) == 0 {
			return offset, nil, nil
		}
		scanned = 0
		advance := len(data)
		token := data
		if i >= 0 {
			advance, token = i+1, data[:i]
			afterCR = data[i] == '\r'
		}
		if first {
			first = false
			token = bytes.TrimPrefix(token, []byte{0xef, 0xbb, 0xbf})
		}
		return offset + advance, token, nil
	}
}

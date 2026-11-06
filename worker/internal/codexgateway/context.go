package codexgateway

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
)

// 自动上下文定位与 Desktop Git XML/JSON 编解码（对齐 codex-proxy-rs transport/automatic_context.rs），
// 供画像版本同步、关联 ID 隔离与隐私规则共用。只处理官方自动上下文，不扫描普通对话与工具输出。
const (
	maxContextBytes = 1 << 20
	maxXMLNodes     = 10000
	maxXMLDepth     = 64
	gitStateOpen    = "<external_codex_git_state>"
	gitStateClose   = "</external_codex_git_state>"
)

type contextTarget struct {
	path        string
	open, close string
	identified  bool
}

func (t contextTarget) complete(text string) bool {
	trimmed := strings.TrimSpace(text)
	return strings.HasPrefix(trimmed, t.open) && strings.HasSuffix(trimmed, t.close)
}

func stringField(object *orderedObject, key string) string {
	if object == nil {
		return ""
	}
	value, _ := object.values[key].(string)
	return value
}

// locateContexts：Desktop Git 状态只在 user 消息；环境文本在 user（environment_context）与
// developer（codex_apps_client_time_context）消息。content_item_kinds 存在时按其标注识别。
func locateContexts(body any, desktop bool, visit func() error) ([]contextTarget, error) {
	root, _ := body.(*orderedObject)
	if root == nil {
		return nil, nil
	}
	items, _ := root.values["input"].([]any)
	var targets []contextTarget
	for itemIndex, raw := range items {
		if err := visit(); err != nil {
			return nil, err
		}
		item, _ := raw.(*orderedObject)
		role := stringField(item, "role")
		if !(role == "user" || (!desktop && role == "developer")) {
			continue
		}
		kind, open, closeTag := "environments.environment_context", "<environment_context>", "</environment_context>"
		switch {
		case desktop:
			kind, open, closeTag = "additional_content.codex_git_state", gitStateOpen, gitStateClose
		case role == "developer":
			kind, open, closeTag = "additional_content.codex_apps_client_time_context", "<codex_apps_client_time_context>", "</codex_apps_client_time_context>"
		}
		kinds, hasKinds := pointerGet(item, "/internal_chat_message_metadata_passthrough/content_item_kinds")
		parts, _ := item.values["content"].([]any)
		for index, rawPart := range parts {
			if err := visit(); err != nil {
				return nil, err
			}
			if hasKinds {
				list, _ := kinds.([]any)
				if index >= len(list) || list[index] != kind {
					continue
				}
			}
			part, _ := rawPart.(*orderedObject)
			if stringField(part, "type") != "input_text" {
				continue
			}
			text, ok := part.values["text"].(string)
			if !ok {
				continue
			}
			trimmed := strings.TrimSpace(text)
			if !hasKinds && !(strings.HasPrefix(trimmed, open) && strings.HasSuffix(trimmed, closeTag)) {
				continue
			}
			targets = append(targets, contextTarget{path: fmt.Sprintf("/input/%d/content/%d/text", itemIndex, index), open: open, close: closeTag, identified: hasKinds})
		}
	}
	return targets, nil
}

type xmlElement struct {
	name  string
	depth int
}

var errContextXML = errors.New("上下文 XML 无法解析或节点数量超限")

// scanXML 严格解析单根 XML 文档，回调每个 token 及其起止偏移；返回元素形状（名称、深度）。
func scanXML(text string, onToken func(token xml.Token, start, end int64, depth int) error) ([]xmlElement, error) {
	decoder := xml.NewDecoder(strings.NewReader(text))
	decoder.Strict = true
	var shape []xmlElement
	depth, roots, nodes := 0, 0, 0
	for {
		start := decoder.InputOffset()
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, errContextXML
		}
		nodes++
		if nodes > maxXMLNodes {
			return nil, errContextXML
		}
		end := decoder.InputOffset()
		switch t := token.(type) {
		case xml.StartElement:
			if depth == 0 {
				roots++
				if roots > 1 {
					return nil, errContextXML
				}
			}
			depth++
			if depth > maxXMLDepth {
				return nil, errors.New("上下文 XML 嵌套超过 64 层")
			}
			shape = append(shape, xmlElement{name: t.Name.Local, depth: depth})
		case xml.EndElement:
			depth--
		case xml.CharData:
			if depth == 0 && len(bytes.TrimSpace(t)) > 0 {
				return nil, errContextXML
			}
		case xml.Directive:
			return nil, errContextXML
		}
		if onToken != nil {
			if err := onToken(token, start, end, depth); err != nil {
				return nil, err
			}
		}
	}
	if roots != 1 || depth != 0 {
		return nil, errContextXML
	}
	return shape, nil
}

// rewriteGitContext 定位 <external_codex_git_state> 内唯一的 environment_context/git 文本节点，
// 以 JSON 对象交给 edit；有改动时只替换该节点的文本（转义 & < >），其余字节保持原样。
func rewriteGitContext(text *string, maxBytes int, edit func(value *any) (int, error)) (int, error) {
	type frame struct{ name string }
	var stack []frame
	rootName := ""
	matches := 0
	var contentStart, contentEnd int64 = -1, -1
	var raw strings.Builder
	inGit, nonText := false, false
	_, err := scanXML(*text, func(token xml.Token, start, end int64, depth int) error {
		switch t := token.(type) {
		case xml.StartElement:
			if rootName == "" {
				rootName = t.Name.Local
			}
			if inGit {
				nonText = true
			}
			if t.Name.Local == "git" && len(stack) > 0 && stack[len(stack)-1].name == "environment_context" {
				matches++
				inGit, contentStart = true, end
			}
			stack = append(stack, frame{name: t.Name.Local})
		case xml.EndElement:
			stack = stack[:len(stack)-1]
			if inGit && t.Name.Local == "git" && len(stack) > 0 && stack[len(stack)-1].name == "environment_context" {
				inGit, contentEnd = false, start
			}
		case xml.CharData:
			if inGit {
				raw.Write(t)
			}
		case xml.Comment, xml.ProcInst:
			if inGit {
				nonText = true
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if rootName != "external_codex_git_state" {
		return 0, errors.New("Desktop Git 包裹不匹配")
	}
	if matches != 1 {
		return 0, errors.New("Desktop Git 数据节点不明确")
	}
	if nonText {
		return 0, errors.New("Desktop Git 数据不是文本")
	}
	value, err := decodeOrdered([]byte(raw.String()))
	if err != nil {
		return 0, errors.New("Desktop Git JSON 无法解析")
	}
	if _, ok := value.(*orderedObject); !ok {
		return 0, errors.New("Desktop Git JSON 必须是对象")
	}
	count, err := edit(&value)
	if err != nil || count == 0 {
		return count, err
	}
	if contentStart < 0 || contentEnd <= contentStart {
		return 0, errors.New("Desktop Git 数据为空")
	}
	encoded, err := encodeOrdered(value)
	if err != nil {
		return 0, errors.New("Desktop Git JSON 无法编码")
	}
	escaped := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(string(encoded))
	if len(*text)-int(contentEnd-contentStart)+len(escaped) > maxBytes {
		return 0, errors.New("Desktop Git 编码结果超出大小限制")
	}
	*text = (*text)[:contentStart] + escaped + (*text)[contentEnd:]
	return count, nil
}

// editGitContexts 对正文中每个完整的官方 Git 上下文执行 edit；未知或损坏上下文保持原样。
func editGitContexts(body any, edit func(value *any) (int, error)) int {
	targets, err := locateContexts(body, true, func() error { return nil })
	if err != nil {
		return 0
	}
	changed := 0
	for _, target := range targets {
		current, ok := pointerGet(body, target.path)
		text, isText := current.(string)
		if !ok || !isText || len(text) > maxContextBytes || !target.complete(text) {
			continue
		}
		if count, err := rewriteGitContext(&text, maxContextBytes, edit); err == nil && count > 0 {
			pointerSet(body, target.path, text)
			changed += count
		}
	}
	return changed
}

// syncGitContext 把 Desktop Git 状态的 appServerVersion/appVersion 同步为本次画像版本，并把其中的
// sessionId/threadId 按账号映射（关联 ID 隔离）。正文不含官方 Git 上下文时原样返回。
func syncGitContext(body []byte, profile wireProfile, installationID string) []byte {
	if !bytes.Contains(body, []byte("external_codex_git_state")) {
		return body
	}
	value, err := decodeOrdered(body)
	if err != nil {
		return body
	}
	appVersion := any(nil)
	if profile.Client == "desktop" && profile.DesktopVersion != "" {
		appVersion = profile.DesktopVersion
	}
	changed := editGitContexts(value, func(state *any) (int, error) {
		object := (*state).(*orderedObject)
		count := 0
		for _, field := range []struct {
			key   string
			value any
		}{{"appServerVersion", profile.CodexVersion}, {"appVersion", appVersion}} {
			current, ok := object.get(field.key)
			if !ok {
				continue
			}
			if _, isString := current.(string); !isString && current != nil {
				continue
			}
			if current != field.value {
				object.set(field.key, field.value)
				count++
			}
		}
		if installationID != "" {
			for _, key := range []string{"sessionId", "threadId"} {
				if current, ok := object.values[key].(string); ok && current != "" {
					object.set(key, scopedID(installationID, current))
					count++
				}
			}
		}
		return count, nil
	})
	if changed == 0 {
		return body
	}
	out, err := encodeOrdered(value)
	if err != nil {
		return body
	}
	return out
}

// environmentShape 用于环境文本：替换前后元素结构（名称、深度序列）必须一致。
func environmentShape(text string) ([]xmlElement, error) {
	return scanXML(text, nil)
}

func sameShape(a, b []xmlElement) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

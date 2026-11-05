package codexgateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// 隐私规则（对齐 codex-proxy-rs transport/privacy 与 settings/privacy.rs）：控制面保存有序规则，Worker 在
// 所有宿主头、画像与 WS 投影完成后、发送前对本次出站副本执行。每条规则的全部步骤同成同败（事务），
// 失败按 onError 跳过该规则或以 400 privacy_policy_rejected 拒绝请求（未发送）。错误只携带规则序号与
// 静态原因，不回显表达式或请求内容。
const (
	privacyMaxRules        = 32
	privacyMaxSteps        = 32
	privacyMaxPathDepth    = 16
	privacyMaxPattern      = 4096
	privacyMaxReplacement  = 4096
	privacyMaxExecSteps    = 10000
	privacyMaxValueBytes   = 1 << 20
	privacyMaxRequestBytes = 32 << 20
	privacyMaxPreviewBytes = 256 << 10
)

// PrivacyPolicy 是控制面下发的规则集（字段名与 CPR camelCase 一致）。
type PrivacyPolicy struct {
	Enabled bool          `json:"enabled"`
	OnError string        `json:"onError"`
	Rules   []PrivacyRule `json:"rules"`
}

type PrivacyRule struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Enabled bool          `json:"enabled"`
	Steps   []PrivacyStep `json:"steps"`
}

type PrivacyStep struct {
	Scope    string  `json:"scope"`
	Selector string  `json:"selector"`
	Action   string  `json:"action"`
	Pattern  *string `json:"pattern"`
	// Replacement 支持 $1、${name}、$$ 捕获组引用
	Replacement     string          `json:"replacement"`
	Value           json.RawMessage `json:"value"`
	ReplaceAll      bool            `json:"replaceAll"`
	CaseInsensitive bool            `json:"caseInsensitive"`
	MultiLine       bool            `json:"multiLine"`
}

// PrivacyError 只描述哪条规则因何失败。
type PrivacyError struct {
	RuleIndex int    `json:"ruleIndex"`
	Reason    string `json:"reason"`
}

func (e *PrivacyError) Error() string {
	return fmt.Sprintf("privacy rule %d: %s", e.RuleIndex+1, e.Reason)
}

type PrivacyRuleOutcome struct {
	RuleID  string `json:"ruleId"`
	Matches int    `json:"matches"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
}

type privacyFailure string

func (f privacyFailure) Error() string { return string(f) }

func fail(reason string) error { return privacyFailure(reason) }

// --- 字段选择器：成员、索引与单层通配 ---

type pathSegment struct {
	key   string
	index int
	kind  byte // 'k' 成员、'i' 索引、'*' 通配
}

func parseSelector(source string) ([]pathSegment, error) {
	if len(source) > 1024 || !strings.HasPrefix(source, "$") {
		return nil, fail("字段路径应以 $ 开头且不超过 1024 字节")
	}
	rest := source[1:]
	var segments []pathSegment
	for rest != "" {
		if len(segments) == privacyMaxPathDepth {
			return nil, fail("字段路径最多 16 层")
		}
		switch {
		case strings.HasPrefix(rest, "."):
			tail := rest[1:]
			end := strings.IndexAny(tail, ".[")
			if end < 0 {
				end = len(tail)
			}
			key := tail[:end]
			if key == "*" {
				segments = append(segments, pathSegment{kind: '*'})
			} else if key != "" && strings.Trim(key, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") == "" {
				segments = append(segments, pathSegment{kind: 'k', key: key})
			} else {
				return nil, fail("成员名包含特殊字符时使用双引号键名")
			}
			rest = tail[end:]
		case strings.HasPrefix(rest, "["):
			tail := rest[1:]
			if strings.HasPrefix(tail, `"`) {
				decoder := json.NewDecoder(strings.NewReader(tail))
				var key string
				if decoder.Decode(&key) != nil {
					return nil, fail("无效的双引号键名")
				}
				after := tail[decoder.InputOffset():]
				if !strings.HasPrefix(after, "]") {
					return nil, fail("字段路径缺少 ]")
				}
				segments = append(segments, pathSegment{kind: 'k', key: key})
				rest = after[1:]
				continue
			}
			value, after, ok := strings.Cut(tail, "]")
			if !ok {
				return nil, fail("字段路径缺少 ]")
			}
			if value == "*" {
				segments = append(segments, pathSegment{kind: '*'})
			} else if index, ok := parseIndex(value); ok {
				segments = append(segments, pathSegment{kind: 'i', index: index})
			} else if value != "" && strings.Trim(value, "0123456789") == "" {
				return nil, fail("数组索引超出范围")
			} else {
				return nil, fail("仅支持数组索引和 * 通配，不支持过滤表达式")
			}
			rest = after
		default:
			return nil, fail("无效的字段路径")
		}
	}
	return segments, nil
}

type privacyBudget struct {
	ctx       context.Context
	steps     int
	textBytes int
}

func (b *privacyBudget) step() error {
	b.steps++
	if b.ctx != nil && b.ctx.Err() != nil {
		return fail("请求已取消或超时")
	}
	if b.steps > privacyMaxExecSteps {
		return fail("规则执行步数超限")
	}
	return nil
}

func (b *privacyBudget) text(text string) error {
	if err := b.step(); err != nil {
		return err
	}
	b.textBytes += len(text)
	if len(text) > privacyMaxValueBytes || b.textBytes > 16*privacyMaxValueBytes {
		return fail("目标文本超出大小限制")
	}
	return nil
}

// visitPath 从后向前访问数组，删除匹配项不改变尚未访问的索引；返回 true 表示调用方应删除该值。
func visitPath(value *any, segments []pathSegment, budget *privacyBudget, apply func(*any) (bool, error)) (bool, error) {
	if err := budget.step(); err != nil {
		return false, err
	}
	if len(segments) == 0 {
		return apply(value)
	}
	first, rest := segments[0], segments[1:]
	switch node := (*value).(type) {
	case *orderedObject:
		switch first.kind {
		case 'k':
			if child, ok := node.values[first.key]; ok {
				removed, err := visitPath(&child, rest, budget, apply)
				if err != nil {
					return false, err
				}
				if removed {
					node.remove(first.key)
				} else {
					node.values[first.key] = child
				}
			}
			return false, nil
		case '*':
			for _, key := range append([]string(nil), node.keys...) {
				child := node.values[key]
				removed, err := visitPath(&child, rest, budget, apply)
				if err != nil {
					return false, err
				}
				if removed {
					node.remove(key)
				} else {
					node.values[key] = child
				}
			}
			return false, nil
		}
	case []any:
		switch first.kind {
		case 'i':
			if first.index < len(node) {
				removed, err := visitPath(&node[first.index], rest, budget, apply)
				if err != nil {
					return false, err
				}
				if removed {
					*value = append(node[:first.index:first.index], node[first.index+1:]...)
				}
			}
			return false, nil
		case '*':
			for index := len(node) - 1; index >= 0; index-- {
				removed, err := visitPath(&node[index], rest, budget, apply)
				if err != nil {
					return false, err
				}
				if removed {
					node = append(node[:index:index], node[index+1:]...)
				}
			}
			*value = node
			return false, nil
		}
	}
	// 缺少字段属于正常未命中，已存在却不符合路径类型属于错误
	return false, fail("目标结构不符合字段路径")
}

// --- 处理步骤 ---

type compiledStep struct {
	step  PrivacyStep
	path  []pathSegment
	regex *regexp.Regexp
	value any
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, c := range []byte(name) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0) {
			return false
		}
	}
	return true
}

func compileStep(step PrivacyStep) (*compiledStep, error) {
	switch step.Scope {
	case "turn_metadata", "desktop_git_context", "environment_text", "request_body", "request_header":
	default:
		return nil, fail("未知的作用范围")
	}
	switch step.Action {
	case "regex_replace", "set_value", "rename_key", "remove_field":
	default:
		return nil, fail("未知的处理动作")
	}
	valueBytes := step.Value
	if len(valueBytes) == 0 {
		valueBytes = json.RawMessage("null")
	}
	if len(step.Replacement) > privacyMaxReplacement || len(valueBytes) > privacyMaxReplacement {
		return nil, fail("替换内容最多 4096 字节")
	}
	value, err := decodeOrdered(valueBytes)
	if err != nil {
		return nil, fail("固定值不是有效 JSON")
	}
	out := &compiledStep{step: step, value: value}
	if step.Scope == "request_header" {
		if !validHeaderName(step.Selector) {
			return nil, fail("请求头名称无效")
		}
		if step.Action == "rename_key" {
			return nil, fail("请求头范围不支持对象键名替换")
		}
	} else if out.path, err = parseSelector(step.Selector); err != nil {
		return nil, err
	}
	if step.Scope == "environment_text" && len(out.path) > 0 {
		return nil, fail("环境文本使用 $ 选择整个文本值")
	}
	if step.Pattern != nil {
		if len(*step.Pattern) > privacyMaxPattern {
			return nil, fail("正则表达式最多 4096 字节")
		}
		flags := ""
		if step.CaseInsensitive {
			flags += "i"
		}
		if step.MultiLine {
			flags += "m"
		}
		pattern := *step.Pattern
		if flags != "" {
			pattern = "(?" + flags + ")" + pattern
		}
		if out.regex, err = regexp.Compile(pattern); err != nil {
			return nil, fail("正则语法无效或复杂度超限，不支持前后顾与模式反向引用")
		}
	}
	if step.Action == "regex_replace" || step.Action == "rename_key" {
		if out.regex == nil {
			return nil, fail("请填写匹配表达式")
		}
		if err := validateReplacement(step.Replacement, out.regex); err != nil {
			return nil, err
		}
	}
	if step.Action == "set_value" && step.Pattern != nil {
		return nil, fail("固定值动作不使用匹配表达式")
	}
	return out, nil
}

// validateReplacement 拒绝引用不存在捕获组的替换模板（$name 由字母数字与 _ 组成，与 Go/Rust 相同）。
func validateReplacement(template string, regex *regexp.Regexp) error {
	rest := template
	for {
		index := strings.IndexByte(rest, '$')
		if index < 0 {
			return nil
		}
		rest = rest[index+1:]
		if strings.HasPrefix(rest, "$") {
			rest = rest[1:]
			continue
		}
		var name string
		if strings.HasPrefix(rest, "{") {
			inner, tail, ok := strings.Cut(rest[1:], "}")
			if !ok {
				return fail("捕获组引用缺少 }")
			}
			name, rest = inner, tail
		} else {
			length := 0
			for length < len(rest) {
				c := rest[length]
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
					break
				}
				length++
			}
			if length == 0 {
				continue
			}
			name, rest = rest[:length], rest[length:]
		}
		valid := false
		if number, err := strconv.Atoi(name); err == nil {
			valid = number >= 0 && number <= regex.NumSubexp()
		} else {
			valid = regex.SubexpIndex(name) >= 0
		}
		if !valid {
			return fail("替换内容引用了不存在的捕获组")
		}
	}
}

func (c *compiledStep) apply(value *any, budget *privacyBudget) (int, error) {
	count := 0
	removed, err := visitPath(value, c.path, budget, func(target *any) (bool, error) {
		return c.applyValue(target, budget, &count)
	})
	if err != nil {
		return 0, err
	}
	if removed {
		return 0, fail("不能删除作用范围根节点")
	}
	return count, nil
}

func (c *compiledStep) applyValue(value *any, budget *privacyBudget, count *int) (bool, error) {
	if err := budget.step(); err != nil {
		return false, err
	}
	switch c.step.Action {
	case "remove_field":
		if c.regex != nil {
			text, ok := (*value).(string)
			if !ok {
				return false, fail("条件删除只能匹配字符串值")
			}
			if err := budget.text(text); err != nil {
				return false, err
			}
			if !c.regex.MatchString(text) {
				return false, nil
			}
		}
		*count++
		return true, nil
	case "set_value":
		if jsonKind(*value) != jsonKind(c.value) {
			return false, fail("固定值必须保持原字段类型")
		}
		*value = cloneOrdered(c.value)
		*count++
	case "regex_replace":
		text, ok := (*value).(string)
		if !ok {
			return false, fail("正则替换只能处理字符串")
		}
		replaced, matches, err := c.replace(text, budget)
		if err != nil {
			return false, err
		}
		*value = replaced
		*count += matches
	case "rename_key":
		object, ok := (*value).(*orderedObject)
		if !ok {
			return false, fail("字段名替换只能处理对象")
		}
		next := newOrderedObject()
		for _, key := range object.keys {
			if err := budget.step(); err != nil {
				return false, err
			}
			replaced, matches, err := c.replace(key, budget)
			if err != nil {
				return false, err
			}
			if _, exists := next.values[replaced]; exists {
				return false, fail("字段名替换产生重名")
			}
			*count += matches
			next.set(replaced, object.values[key])
		}
		*value = next
	}
	return false, nil
}

func (c *compiledStep) replace(text string, budget *privacyBudget) (string, int, error) {
	if err := budget.text(text); err != nil {
		return "", 0, err
	}
	limit := 1
	if c.step.ReplaceAll {
		limit = -1
	}
	references := strings.Count(c.step.Replacement, "$")
	var output []byte
	end, count := 0, 0
	for _, match := range c.regex.FindAllStringSubmatchIndex(text, limit) {
		if err := budget.step(); err != nil {
			return "", 0, err
		}
		output = append(output, text[end:match[0]]...)
		largest := 0
		for i := 0; i+1 < len(match); i += 2 {
			if match[i] >= 0 && match[i+1]-match[i] > largest {
				largest = match[i+1] - match[i]
			}
		}
		if len(output)+len(c.step.Replacement)+largest*references > privacyMaxValueBytes {
			return "", 0, fail("捕获组展开超出大小限制")
		}
		output = c.regex.ExpandString(output, c.step.Replacement, text, match)
		if len(output) > privacyMaxValueBytes {
			return "", 0, fail("替换结果超出大小限制")
		}
		end = match[1]
		count++
	}
	output = append(output, text[end:]...)
	if len(output) > privacyMaxValueBytes {
		return "", 0, fail("替换结果超出大小限制")
	}
	return string(output), count, nil
}

// --- 正文事务：步骤先在片段副本上执行，提交后记录原片段，规则失败时逆序恢复 ---

func encodedSize(value any) (int, error) {
	data, err := encodeOrdered(value)
	if err != nil || len(data) > privacyMaxRequestBytes {
		return 0, fail("请求或预览样本超出大小限制")
	}
	return len(data), nil
}

type bodyChange struct {
	path  string
	value any
}

type bodyChanges struct {
	originalSize, removed, added int
	replacements                 []bodyChange
}

func (c *bodyChanges) stage(body any, path string, budget *privacyBudget, apply func(*any, *privacyBudget) (int, error)) (int, error) {
	original, ok := pointerGet(body, path)
	if !ok {
		return 0, fail("目标正文片段不存在")
	}
	next := cloneOrdered(original)
	count, err := apply(&next, budget)
	if err != nil || count == 0 {
		return count, err
	}
	if path == "" {
		c.removed += c.originalSize
	} else {
		size, err := encodedSize(original)
		if err != nil {
			return 0, err
		}
		c.removed += size
	}
	size, err := encodedSize(next)
	if err != nil {
		return 0, err
	}
	c.added += size
	if c.added > privacyMaxRequestBytes {
		return 0, fail("请求或预览样本超出大小限制")
	}
	c.replacements = append(c.replacements, bodyChange{path: path, value: next})
	return count, nil
}

func (c *bodyChanges) size() (int, error) {
	size := c.originalSize - c.removed + c.added
	if size < 0 || size > privacyMaxRequestBytes {
		return 0, fail("请求或预览样本超出大小限制")
	}
	return size, nil
}

type bodyTransaction struct {
	body      *any
	originals []bodyChange
}

func (t *bodyTransaction) commit(changes *bodyChanges) {
	for _, change := range changes.replacements {
		if change.path == "" {
			t.originals = append(t.originals, bodyChange{path: "", value: *t.body})
			*t.body = change.value
			continue
		}
		original, ok := pointerGet(*t.body, change.path)
		if !ok {
			continue
		}
		t.originals = append(t.originals, bodyChange{path: change.path, value: original})
		pointerSet(*t.body, change.path, change.value)
	}
}

func (t *bodyTransaction) rollback() {
	for i := len(t.originals) - 1; i >= 0; i-- {
		original := t.originals[i]
		if original.path == "" {
			*t.body = original.value
		} else {
			pointerSet(*t.body, original.path, original.value)
		}
	}
	t.originals = nil
}

// --- 承载点 ---

var privacyMetadataKeys = []string{"turnMetadata", "turn_metadata", "x-codex-turn-metadata"}

type contextIndex struct {
	desktop, environment   []contextTarget
	desktopReady, envReady bool
}

func (c *compiledStep) prepare(body any, header http.Header, turnMetadata *string, changes *bodyChanges, contexts *contextIndex, budget *privacyBudget) (int, error) {
	switch c.step.Scope {
	case "turn_metadata":
		count := 0
		if turnMetadata != nil && *turnMetadata != "" {
			matches, err := c.metadata(turnMetadata, budget)
			if err != nil {
				return 0, err
			}
			count += matches
		}
		if values := header.Values("x-codex-turn-metadata"); len(values) > 0 {
			next := make([]string, len(values))
			for i, raw := range values {
				matches, err := c.metadata(&raw, budget)
				if err != nil {
					return 0, err
				}
				if !asciiHeaderValue(raw) {
					return 0, fail("metadata 请求头编码无效")
				}
				next[i] = raw
				count += matches
			}
			header.Del("x-codex-turn-metadata")
			for _, value := range next {
				header.Add("x-codex-turn-metadata", value)
			}
		}
		for _, prefix := range []string{"", "/client_metadata"} {
			for _, key := range privacyMetadataKeys {
				path := prefix + "/" + key
				if _, ok := pointerGet(body, path); !ok {
					continue
				}
				matches, err := changes.stage(body, path, budget, func(next *any, budget *privacyBudget) (int, error) {
					switch value := (*next).(type) {
					case string:
						matches, err := c.metadata(&value, budget)
						*next = value
						return matches, err
					case *orderedObject:
						return c.apply(next, budget)
					}
					return 0, fail("metadata 必须是 JSON 对象或编码后的字符串")
				})
				if err != nil {
					return 0, err
				}
				count += matches
			}
		}
		return count, nil
	case "desktop_git_context", "environment_text":
		return contexts.apply(c, body, changes, budget)
	case "request_body":
		return changes.stage(body, "", budget, c.apply)
	case "request_header":
		values := header.Values(c.step.Selector)
		if len(values) == 0 {
			return 0, nil
		}
		items := make([]any, len(values))
		for i, value := range values {
			items[i] = value
		}
		count := 0
		for index := len(items) - 1; index >= 0; index-- {
			removed, err := c.applyValue(&items[index], budget, &count)
			if err != nil {
				return 0, err
			}
			if removed {
				items = append(items[:index:index], items[index+1:]...)
			}
		}
		if count == 0 {
			return 0, nil
		}
		header.Del(c.step.Selector)
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return 0, fail("请求头只能保存字符串")
			}
			// WS 握手会忽略非 ASCII 头，预览应提前暴露这个失败
			if !asciiHeaderValue(text) {
				return 0, fail("替换结果必须是 ASCII 请求头值")
			}
			header.Add(c.step.Selector, text)
		}
		return count, nil
	}
	return 0, fail("未知的作用范围")
}

func asciiHeaderValue(value string) bool {
	for _, c := range []byte(value) {
		if c == '\r' || c == '\n' || c == 0 || c > 126 || (c < 32 && c != '\t') {
			return false
		}
	}
	return true
}

func (c *compiledStep) metadata(raw *string, budget *privacyBudget) (int, error) {
	if err := budget.text(*raw); err != nil {
		return 0, err
	}
	value, err := decodeOrdered([]byte(*raw))
	if err != nil {
		return 0, fail("metadata JSON 无法解析")
	}
	if _, ok := value.(*orderedObject); !ok {
		return 0, fail("metadata 必须是对象")
	}
	count, err := c.apply(&value, budget)
	if err != nil || count == 0 {
		return count, err
	}
	encoded, err := encodeOrdered(value)
	if err != nil {
		return 0, fail("metadata 无法编码")
	}
	text := asciiJSON(encoded)
	if len(text) > privacyMaxValueBytes {
		return 0, fail("metadata 编码结果超出大小限制")
	}
	*raw = text
	return count, nil
}

func (x *contextIndex) apply(c *compiledStep, body any, changes *bodyChanges, budget *privacyBudget) (int, error) {
	desktop := c.step.Scope == "desktop_git_context"
	targets, ready := &x.environment, &x.envReady
	if desktop {
		targets, ready = &x.desktop, &x.desktopReady
	}
	if !*ready {
		located, err := locateContexts(body, desktop, budget.step)
		if err != nil {
			return 0, err
		}
		*targets, *ready = located, true
	}
	count := 0
	for _, target := range *targets {
		if err := budget.step(); err != nil {
			return 0, err
		}
		current, _ := pointerGet(body, target.path)
		text, ok := current.(string)
		if !ok {
			return 0, fail("上下文文本不存在")
		}
		if !target.complete(text) {
			if target.identified {
				return 0, fail("已识别上下文不完整，可能已被截断")
			}
			continue
		}
		if err := budget.text(text); err != nil {
			return 0, err
		}
		matches, err := changes.stage(body, target.path, budget, func(next *any, budget *privacyBudget) (int, error) {
			text, ok := (*next).(string)
			if !ok {
				return 0, fail("上下文必须是文本")
			}
			var count int
			var err error
			if desktop {
				if err := budget.step(); err != nil {
					return 0, err
				}
				count, err = rewriteGitContext(&text, privacyMaxValueBytes, func(value *any) (int, error) { return c.apply(value, budget) })
			} else {
				count, err = c.environment(&text, budget)
			}
			*next = text
			return count, err
		})
		if err != nil {
			return 0, err
		}
		count += matches
	}
	return count, nil
}

func (c *compiledStep) environment(text *string, budget *privacyBudget) (int, error) {
	before, err := environmentShape(*text)
	if err != nil {
		return 0, fail(err.Error())
	}
	value := any(*text)
	count, err := c.apply(&value, budget)
	if err != nil {
		return 0, err
	}
	result, ok := value.(string)
	if !ok {
		return 0, fail("环境上下文必须是文本")
	}
	after, err := environmentShape(result)
	if err != nil {
		return 0, fail(err.Error())
	}
	if !sameShape(before, after) {
		return 0, fail("替换不能改变环境上下文包裹结构")
	}
	*text = result
	return count, nil
}

// --- 编译与执行 ---

type compiledRule struct {
	id      string
	enabled bool
	steps   []*compiledStep
}

type compiledPrivacy struct {
	enabled bool
	reject  bool
	rules   []compiledRule
}

func compilePrivacy(policy *PrivacyPolicy) (*compiledPrivacy, error) {
	if len(policy.Rules) > privacyMaxRules {
		return nil, &PrivacyError{Reason: "最多配置 32 条规则"}
	}
	if policy.OnError != "" && policy.OnError != "skip_rule" && policy.OnError != "reject_request" {
		return nil, &PrivacyError{Reason: "未知的失败处理方式"}
	}
	out := &compiledPrivacy{enabled: policy.Enabled, reject: policy.OnError == "reject_request"}
	ids := map[string]bool{}
	total := 0
	for index, rule := range policy.Rules {
		if rule.ID == "" || len(rule.ID) > 64 || rule.Name == "" || len(rule.Name) > 192 {
			return nil, &PrivacyError{RuleIndex: index, Reason: "规则 ID 或名称长度不合法"}
		}
		if ids[rule.ID] {
			return nil, &PrivacyError{RuleIndex: index, Reason: "规则 ID 重复"}
		}
		ids[rule.ID] = true
		total += len(rule.Steps)
		if len(rule.Steps) == 0 || total > privacyMaxSteps {
			return nil, &PrivacyError{RuleIndex: index, Reason: "每条规则至少一个处理步骤，所有规则合计最多 32 个步骤"}
		}
		compiled := compiledRule{id: rule.ID, enabled: rule.Enabled}
		for _, step := range rule.Steps {
			c, err := compileStep(step)
			if err != nil {
				return nil, &PrivacyError{RuleIndex: index, Reason: err.Error()}
			}
			compiled.steps = append(compiled.steps, c)
		}
		out.rules = append(out.rules, compiled)
	}
	return out, nil
}

// active 表示至少有一条会执行的规则；否则出站路径不解码正文。
func (p *compiledPrivacy) active() bool {
	if p == nil || !p.enabled {
		return false
	}
	for _, rule := range p.rules {
		if rule.enabled {
			return true
		}
	}
	return false
}

// apply 按顺序执行规则；header 与 turnMetadata 在规则成功后才替换为新副本。
func (p *compiledPrivacy) apply(ctx context.Context, body *any, header http.Header, turnMetadata *string) ([]PrivacyRuleOutcome, error) {
	budget := &privacyBudget{ctx: ctx}
	var outcomes []PrivacyRuleOutcome
	bodySize := -1
	contexts := &contextIndex{}
	for index, rule := range p.rules {
		outcome := PrivacyRuleOutcome{RuleID: rule.id, Status: "disabled"}
		if p.enabled && rule.enabled {
			nextHeader := header.Clone()
			if nextHeader == nil {
				nextHeader = http.Header{}
			}
			var nextMetadata *string
			if turnMetadata != nil {
				copied := *turnMetadata
				nextMetadata = &copied
			}
			transaction := &bodyTransaction{body: body}
			count, size, err := func() (int, int, error) {
				if err := budget.step(); err != nil {
					return 0, 0, err
				}
				if bodySize < 0 {
					size, err := encodedSize(*body)
					if err != nil {
						return 0, 0, err
					}
					bodySize = size
				}
				size := bodySize
				count := 0
				for _, step := range rule.steps {
					if err := budget.step(); err != nil {
						return 0, 0, err
					}
					changes := &bodyChanges{originalSize: size}
					matches, err := step.prepare(*body, nextHeader, nextMetadata, changes, contexts, budget)
					if err != nil {
						return 0, 0, err
					}
					if size, err = changes.size(); err != nil {
						return 0, 0, err
					}
					if err := budget.step(); err != nil {
						return 0, 0, err
					}
					transaction.commit(changes)
					count += matches
					if matches > 0 && step.step.Scope == "request_body" {
						contexts = &contextIndex{}
					}
				}
				return count, size, budget.step()
			}()
			if err != nil {
				transaction.rollback()
				// 索引可能来自已回滚的中间正文，不能复用到下一条规则
				contexts = &contextIndex{}
				if p.reject || (ctx != nil && ctx.Err() != nil) {
					return nil, &PrivacyError{RuleIndex: index, Reason: err.Error()}
				}
				outcome.Status, outcome.Reason = "skipped", err.Error()
			} else {
				for key := range header {
					delete(header, key)
				}
				for key, values := range nextHeader {
					header[key] = values
				}
				if turnMetadata != nil {
					*turnMetadata = *nextMetadata
				}
				bodySize = size
				outcome.Matches = count
				outcome.Status = "unmatched"
				if count > 0 {
					outcome.Status = "applied"
				}
			}
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes, nil
}

// applyBody 是出站入口：正文为 JSON 字节，返回改写后的字节（无改动时原样）。
func (p *compiledPrivacy) applyBody(ctx context.Context, body []byte, header http.Header) ([]byte, error) {
	if !p.active() {
		return body, nil
	}
	value, err := decodeOrdered(body)
	if err != nil {
		return nil, &PrivacyError{Reason: "请求正文不是有效 JSON"}
	}
	outcomes, err := p.apply(ctx, &value, header, nil)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, outcome := range outcomes {
		changed = changed || outcome.Matches > 0
	}
	if !changed {
		return body, nil
	}
	return encodeOrdered(value)
}

// privacyCache 按策略指纹缓存编译结果；心跳下发的通用策略作为信封未携带时的回退。
type privacyCache struct {
	mu      sync.Mutex
	entries map[string]*compiledPrivacy
	order   []string
	current *compiledPrivacy
}

func newPrivacyCache() *privacyCache { return &privacyCache{entries: map[string]*compiledPrivacy{}} }

func privacyFingerprint(policy *PrivacyPolicy) string {
	data, _ := json.Marshal(policy)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (c *privacyCache) compile(policy *PrivacyPolicy) (*compiledPrivacy, error) {
	if policy == nil {
		return nil, nil
	}
	key := privacyFingerprint(policy)
	c.mu.Lock()
	defer c.mu.Unlock()
	if compiled, ok := c.entries[key]; ok {
		return compiled, nil
	}
	compiled, err := compilePrivacy(policy)
	if err != nil {
		return nil, err
	}
	c.entries[key] = compiled
	c.order = append(c.order, key)
	if len(c.order) > 16 {
		delete(c.entries, c.order[0])
		c.order = c.order[1:]
	}
	return compiled, nil
}

// observe 记录心跳下发的通用策略；编译失败时保留上一份有效策略。
func (c *privacyCache) observe(policy *PrivacyPolicy) {
	compiled, err := c.compile(policy)
	if err != nil {
		return
	}
	c.mu.Lock()
	c.current = compiled
	c.mu.Unlock()
}

// forRequest 返回本请求冻结的策略：信封携带时以信封为准（编译失败按拒绝处理），否则用通用策略。
func (c *privacyCache) forRequest(policy *PrivacyPolicy) (*compiledPrivacy, error) {
	if policy != nil {
		return c.compile(policy)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current, nil
}

var errPrivacyRejected = errors.New("privacy policy rejected the request")

// PrivacyPreviewRequest 是管理员提供的受限样本（最多 256 KiB），不读取实际请求记录。
type PrivacyPreviewRequest struct {
	Policy       PrivacyPolicy       `json:"policy"`
	Body         json.RawMessage     `json:"body"`
	Headers      map[string][]string `json:"headers"`
	TurnMetadata *string             `json:"turnMetadata"`
}

type privacyPreviewResult struct {
	Body         json.RawMessage      `json:"body"`
	Headers      map[string][]string  `json:"headers"`
	TurnMetadata *string              `json:"turnMetadata"`
	Outcomes     []PrivacyRuleOutcome `json:"outcomes"`
}

func previewPrivacy(request PrivacyPreviewRequest) (*privacyPreviewResult, error) {
	if len(request.Body) == 0 {
		request.Body = json.RawMessage("{}")
	}
	if len(request.Body) > privacyMaxPreviewBytes {
		return nil, &PrivacyError{Reason: "请求或预览样本超出大小限制"}
	}
	size := 0
	header := http.Header{}
	for key, values := range request.Headers {
		if !validHeaderName(key) {
			return nil, &PrivacyError{Reason: "预览请求头名称无效"}
		}
		size += len(key)
		for _, value := range values {
			if !asciiHeaderValue(value) {
				return nil, &PrivacyError{Reason: "预览请求头值无效"}
			}
			size += len(value)
			header.Add(key, value)
		}
	}
	if request.TurnMetadata != nil {
		size += len(*request.TurnMetadata)
	}
	if size > privacyMaxPreviewBytes {
		return nil, &PrivacyError{Reason: "预览样本最多 256 KiB"}
	}
	compiled, err := compilePrivacy(&request.Policy)
	if err != nil {
		return nil, err
	}
	value, err := decodeOrdered(request.Body)
	if err != nil {
		return nil, &PrivacyError{Reason: "预览正文不是有效 JSON"}
	}
	outcomes, err := compiled.apply(context.Background(), &value, header, request.TurnMetadata)
	if err != nil {
		return nil, err
	}
	body, err := encodeOrdered(value)
	if err != nil {
		return nil, err
	}
	headers := map[string][]string{}
	for key, values := range header {
		headers[strings.ToLower(key)] = values
	}
	return &privacyPreviewResult{Body: body, Headers: headers, TurnMetadata: request.TurnMetadata, Outcomes: outcomes}, nil
}

// privacyPreview：POST /internal/v1/privacy/preview，用管理员提供的样本试运行规则。
func (s *Server) privacyPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "use POST")
		return
	}
	var input PrivacyPreviewRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 2*privacyMaxPreviewBytes)).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	result, err := previewPrivacy(input)
	if err != nil {
		var privacyErr *PrivacyError
		if errors.As(err, &privacyErr) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": map[string]any{"code": "privacy_policy_invalid", "rule_index": privacyErr.RuleIndex, "reason": privacyErr.Reason}})
			return
		}
		writeError(w, http.StatusBadRequest, "privacy_policy_invalid", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

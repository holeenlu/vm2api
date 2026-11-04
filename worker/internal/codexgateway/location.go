package codexgateway

import (
	"bytes"
	"encoding/xml"
	"errors"
	"strings"
	"time"
	_ "time/tzdata" // 容器镜像可能没有 zoneinfo，时区校验内嵌 IANA 数据
	"unicode"
)

// 请求位置（对齐 codex-proxy-rs account/location.rs、transport/request.rs）：账号走代理时使用控制面
// 投影的代理位置（手动设置或代理池按出口探测的结果），否则使用控制面的全局位置（开启时）。
// 发送前只改写官方环境/时间上下文里的 <timezone> 与 web_search 工具的 user_location；
// 上下文日期是客户端生成时的事实，不随位置刷新。
type RequestLocation struct {
	Country  string `json:"country"`
	Region   string `json:"region"`
	City     string `json:"city"`
	Timezone string `json:"timezone"`
}

var errLocationInvalid = errors.New("request location is invalid")

func locationText(value string) bool {
	for _, c := range value {
		if unicode.IsControl(c) {
			return false
		}
	}
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && len([]rune(trimmed)) <= 128
}

// normalized 校验并去掉地区、城市首尾空白；时区必须是 IANA 名称。
func (l RequestLocation) normalized() (RequestLocation, error) {
	if len(l.Country) != 2 || strings.ToUpper(l.Country) != l.Country || !(l.Country[0] >= 'A' && l.Country[0] <= 'Z' && l.Country[1] >= 'A' && l.Country[1] <= 'Z') {
		return RequestLocation{}, errLocationInvalid
	}
	if !locationText(l.Region) || !locationText(l.City) {
		return RequestLocation{}, errLocationInvalid
	}
	if l.Timezone == "" || l.Timezone == "Local" {
		return RequestLocation{}, errLocationInvalid
	}
	if _, err := time.LoadLocation(l.Timezone); err != nil {
		return RequestLocation{}, errLocationInvalid
	}
	l.Region, l.City = strings.TrimSpace(l.Region), strings.TrimSpace(l.City)
	return l, nil
}

// requestLocationFor：代理位置只在账号确实经代理出站时生效，否则回退全局位置。
func requestLocationFor(account Account, global *RequestLocation) *RequestLocation {
	if account.ProxyURL != "" && account.RequestLocation != nil {
		return account.RequestLocation
	}
	return global
}

const (
	environmentContextKind = "environments.environment_context"
	desktopTimeContextKind = "additional_content.codex_apps_client_time_context"
)

// alignRequestLocation 改写正文中的时区上下文与 web_search 位置；无可改内容时原样返回。
func alignRequestLocation(body []byte, location *RequestLocation) []byte {
	if location == nil || (!bytes.Contains(body, []byte("<timezone")) && !bytes.Contains(body, []byte("web_search"))) {
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
	if input, ok := root.values["input"].([]any); ok {
		for _, item := range input {
			if object, ok := item.(*orderedObject); ok && alignTimeContext(object, location.Timezone) {
				changed = true
			}
		}
	}
	if tools, ok := root.values["tools"].([]any); ok {
		for _, raw := range tools {
			tool, ok := raw.(*orderedObject)
			if !ok {
				continue
			}
			kind := stringField(tool, "type")
			if kind != "web_search" && !strings.HasPrefix(kind, "web_search_") {
				continue
			}
			userLocation := newOrderedObject()
			userLocation.set("type", "approximate")
			userLocation.set("country", location.Country)
			userLocation.set("region", location.Region)
			userLocation.set("city", location.City)
			userLocation.set("timezone", location.Timezone)
			tool.set("user_location", userLocation)
			changed = true
		}
	}
	if !changed {
		return body
	}
	out, err := encodeOrdered(root)
	if err != nil {
		return body
	}
	return out
}

// alignTimeContext：user 消息的 environment_context 与 developer 消息的 codex_apps_client_time_context；
// content_item_kinds 存在时以其分类为准，缺省时按角色与完整上下文识别。
func alignTimeContext(item *orderedObject, timezone string) bool {
	var tag, kind string
	switch stringField(item, "role") {
	case "user":
		tag, kind = "environment_context", environmentContextKind
	case "developer":
		tag, kind = "codex_apps_client_time_context", desktopTimeContextKind
	default:
		return false
	}
	kinds, hasKinds := pointerGet(item, "/internal_chat_message_metadata_passthrough/content_item_kinds")
	kindList, _ := kinds.([]any)
	content, _ := item.values["content"].([]any)
	changed := false
	for index, raw := range content {
		if hasKinds && (kindList == nil || index >= len(kindList) || kindList[index] != kind) {
			continue
		}
		part, ok := raw.(*orderedObject)
		if !ok || stringField(part, "type") != "input_text" {
			continue
		}
		text, ok := part.values["text"].(string)
		if !ok {
			continue
		}
		if aligned, ok := alignedTimeContext(text, tag, timezone); ok {
			part.set("text", aligned)
			changed = true
		}
	}
	return changed
}

// alignedTimeContext 只替换根元素下的 <timezone> 子元素（整段替换），其余字节保持原样。
func alignedTimeContext(text, tag, timezone string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "<"+tag+">") || !strings.HasSuffix(trimmed, "</"+tag+">") {
		return "", false
	}
	type span struct{ start, end int64 }
	var spans []span
	var open int64 = -1
	root := ""
	_, err := scanXML(text, func(token xml.Token, start, end int64, depth int) error {
		switch t := token.(type) {
		case xml.StartElement:
			if depth == 1 {
				root = t.Name.Local
			}
			if depth == 2 && t.Name.Local == "timezone" {
				open = start
			}
		case xml.EndElement:
			if depth == 1 && t.Name.Local == "timezone" && open >= 0 {
				spans = append(spans, span{open, end})
				open = -1
			}
		}
		return nil
	})
	if err != nil || root != tag || len(spans) == 0 {
		return "", false
	}
	replacement := "<timezone>" + escapeXMLText(timezone) + "</timezone>"
	out := text
	for i := len(spans) - 1; i >= 0; i-- {
		out = out[:spans[i].start] + replacement + out[spans[i].end:]
	}
	return out, out != text
}

func escapeXMLText(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

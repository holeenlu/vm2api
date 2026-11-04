package codexgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// 保序 JSON 值：对象键保持原顺序，数字保持原文本。隐私规则与自动上下文同步在它上面改写正文，
// 序列化后其余字段的顺序与原文一致（WS 首帧字段顺序属于线级指纹）。
type orderedObject struct {
	keys   []string
	values map[string]any
}

func newOrderedObject() *orderedObject { return &orderedObject{values: map[string]any{}} }

func (o *orderedObject) get(key string) (any, bool) {
	value, ok := o.values[key]
	return value, ok
}

func (o *orderedObject) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *orderedObject) remove(key string) {
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func decodeOrdered(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeOrderedValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing data after JSON value")
	}
	return value, nil
}

func decodeOrderedValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 512 {
		return nil, errors.New("JSON nesting too deep")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := newOrderedObject()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyToken.(string)
				child, err := decodeOrderedValue(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				object.set(key, child)
			}
			_, err := decoder.Token()
			return object, err
		case '[':
			items := []any{}
			for decoder.More() {
				child, err := decodeOrderedValue(decoder, depth+1)
				if err != nil {
					return nil, err
				}
				items = append(items, child)
			}
			_, err := decoder.Token()
			return items, err
		}
		return nil, errors.New("unexpected delimiter")
	default:
		return value, nil
	}
}

func encodeOrdered(value any) ([]byte, error) {
	var out bytes.Buffer
	if err := writeOrdered(&out, value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func writeOrdered(out *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case *orderedObject:
		out.WriteByte('{')
		for i, key := range v.keys {
			if i > 0 {
				out.WriteByte(',')
			}
			writeJSONString(out, key)
			out.WriteByte(':')
			if err := writeOrdered(out, v.values[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	case []any:
		out.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeOrdered(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case string:
		writeJSONString(out, v)
	case json.Number:
		out.WriteString(v.String())
	case nil:
		out.WriteString("null")
	case bool:
		if v {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		out.Write(data)
	}
	return nil
}

// writeJSONString 与 serde_json 相同：不转义 HTML 字符，只转义控制字符、引号与反斜杠。
func writeJSONString(out *bytes.Buffer, value string) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	out.WriteString(strings.TrimSuffix(buffer.String(), "\n"))
}

// orderedFromPlain 把 encoding/json 解码的普通值（固定值规则）转为保序值。
func orderedFromPlain(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	out, err := decodeOrdered(data)
	if err != nil {
		return value
	}
	return out
}

// jsonKind 用于“固定值必须保持原字段类型”的判断。
func jsonKind(value any) string {
	switch value.(type) {
	case *orderedObject, map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case json.Number, float64, int, int64:
		return "number"
	case bool:
		return "bool"
	case nil:
		return "null"
	}
	return "unknown"
}

// pointerGet / pointerSet 实现 RFC 6901 子集（无转义），供自动上下文定位使用。
func pointerGet(root any, pointer string) (any, bool) {
	if pointer == "" {
		return root, true
	}
	current := root
	for _, part := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		switch node := current.(type) {
		case *orderedObject:
			next, ok := node.get(part)
			if !ok {
				return nil, false
			}
			current = next
		case []any:
			index, ok := parseIndex(part)
			if !ok || index >= len(node) {
				return nil, false
			}
			current = node[index]
		default:
			return nil, false
		}
	}
	return current, true
}

func pointerSet(root any, pointer string, value any) bool {
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	parent, ok := pointerGet(root, "/"+strings.Join(parts[:len(parts)-1], "/"))
	if len(parts) == 1 {
		parent, ok = root, true
	}
	if !ok {
		return false
	}
	last := parts[len(parts)-1]
	switch node := parent.(type) {
	case *orderedObject:
		node.set(last, value)
		return true
	case []any:
		index, ok := parseIndex(last)
		if !ok || index >= len(node) {
			return false
		}
		node[index] = value
		return true
	}
	return false
}

func parseIndex(text string) (int, bool) {
	if text == "" || len(text) > 9 {
		return 0, false
	}
	value := 0
	for _, c := range text {
		if c < '0' || c > '9' {
			return 0, false
		}
		value = value*10 + int(c-'0')
	}
	return value, true
}

// cloneOrdered 深拷贝（规则事务回滚用）。
func cloneOrdered(value any) any {
	switch v := value.(type) {
	case *orderedObject:
		out := &orderedObject{keys: append([]string(nil), v.keys...), values: make(map[string]any, len(v.values))}
		for key, child := range v.values {
			out.values[key] = cloneOrdered(child)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = cloneOrdered(child)
		}
		return out
	}
	return value
}

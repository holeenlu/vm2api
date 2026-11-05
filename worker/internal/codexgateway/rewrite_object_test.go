package codexgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

// referenceRewriteObject 是改为结构扫描前基于 encoding/json Decoder 的实现，作为输出等价的参照。
func referenceRewriteObject(data []byte, fn func(string, json.RawMessage) (json.RawMessage, bool, bool)) ([]byte, bool, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, false, err
	}
	if token != json.Delim('{') {
		return nil, false, fmt.Errorf("not a JSON object")
	}
	var out bytes.Buffer
	out.WriteByte('{')
	first, changed := true, false
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, false, err
		}
		key, _ := token.(string)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false, err
		}
		next, drop, did := fn(key, value)
		if did {
			changed = true
		}
		if drop {
			continue
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		name, _ := json.Marshal(key)
		out.Write(name)
		out.WriteByte(':')
		out.Write(next)
	}
	out.WriteByte('}')
	return out.Bytes(), changed, nil
}

func TestRewriteObjectMatchesDecoderReference(t *testing.T) {
	bodies := []string{
		`{}`,
		` { } `,
		`{"a":1}`,
		"{ \"model\" : \"gpt\" ,\n\t\"input\" : [ {\"t\":\"x\\\"}]{[\"} , 1.5e3, -2, true, false, null ] , \"n\":null }",
		`{"k<y":"<v>","中":"文","esc":"a\\b\"c\n","nested":{"x":[[],{}],"y":{"z":[1,{"w":"}"}]}}}`,
		`{"service_tier":"default","previous_response_id":"r","client_metadata":{"x-codex-installation-id":"x"},"prompt_cache_key":"k"}`,
		string(largeRequestBody()),
	}
	fns := map[string]func(string, json.RawMessage) (json.RawMessage, bool, bool){
		"keep": func(_ string, v json.RawMessage) (json.RawMessage, bool, bool) { return v, false, false },
		"drop": func(k string, v json.RawMessage) (json.RawMessage, bool, bool) {
			return v, k == "previous_response_id" || k == "n", k == "n"
		},
		"replace": func(k string, v json.RawMessage) (json.RawMessage, bool, bool) {
			return json.RawMessage(`"z"`), false, k == "model"
		},
	}
	for i, body := range bodies {
		for name, fn := range fns {
			want, wantChanged, wantErr := referenceRewriteObject([]byte(body), fn)
			got, gotChanged, gotErr := rewriteObject([]byte(body), fn)
			if (wantErr == nil) != (gotErr == nil) || !bytes.Equal(want, got) || wantChanged != gotChanged {
				t.Fatalf("body %d fn %s: want (%q,%v,%v) got (%q,%v,%v)", i, name, trim(want), wantChanged, wantErr, trim(got), gotChanged, gotErr)
			}
		}
	}
	for _, invalid := range []string{``, `[]`, `"x"`, `{"a"}`, `{"a":}`, `{"a":1,}`, `{"a":[1}`, `{"a":"x`, `{"a":1 "b":2}`} {
		if _, _, err := rewriteObject([]byte(invalid), fns["keep"]); err == nil {
			t.Fatalf("expected error for %q", invalid)
		}
	}
}

func trim(b []byte) string {
	if len(b) > 200 {
		return string(b[:200]) + "..."
	}
	return string(b)
}

// largeRequestBody 构造约 2.5 MB 的多轮历史正文，覆盖大字段透传。
func largeRequestBody() []byte {
	chunk := bytes.Repeat([]byte("lorem ipsum \"quoted\" {brace} [bracket] "), 50)
	input := []any{}
	for i := 0; i < 1000; i++ {
		input = append(input, map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": fmt.Sprintf("%d %s", i, chunk)}}})
	}
	body, _ := json.Marshal(map[string]any{"model": "gpt-6-astra", "input": input, "service_tier": "default", "client_metadata": map[string]any{"parent_response_id": "resp_p"}})
	return body
}

func TestTopLevelSubsetReadsOnlyRequestedMembers(t *testing.T) {
	body := []byte(`{"model":"a","input":[{"model":"nested"}],"service_tier":"priority","model":"b","generate":false}`)
	if got := string(topLevelSubset(body, "model", "service_tier", "missing")); got != `{"model":"b","service_tier":"priority"}` {
		t.Fatalf("subset=%s", got)
	}
	if topLevelSubset([]byte(`{"model":`), "model") != nil {
		t.Fatal("invalid body must yield nil")
	}
	large := largeRequestBody()
	if serviceTierOf(large) != "default" || guardianParentID(large) != "resp_p" || codexRoutingHint(large) != "model=gpt-6-astra;tier=default" {
		t.Fatalf("large body fields: tier=%q parent=%q hint=%q", serviceTierOf(large), guardianParentID(large), codexRoutingHint(large))
	}
}

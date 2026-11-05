package codexgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestLocationValidationAndAlignment(t *testing.T) {
	for _, bad := range []RequestLocation{
		{Country: "us", Region: "Ohio", City: "Piketon", Timezone: "America/New_York"},
		{Country: "US", Region: "Oh\nio", City: "Piketon", Timezone: "America/New_York"},
		{Country: "US", Region: " ", City: "Piketon", Timezone: "America/New_York"},
		{Country: "US", Region: "Ohio", City: "Piketon", Timezone: "Mars/Base"},
		{Country: "US", Region: "Ohio", City: "Piketon", Timezone: "Local"},
	} {
		if _, err := bad.normalized(); err == nil {
			t.Fatalf("%+v accepted", bad)
		}
	}
	location, err := RequestLocation{Country: "JP", Region: " Tokyo ", City: "Chiyoda", Timezone: "Asia/Tokyo"}.normalized()
	if err != nil || location.Region != "Tokyo" {
		t.Fatalf("location=%+v err=%v", location, err)
	}
	env := "<environment_context>\n  <cwd>/w</cwd>\n  <current_date>2026-11-03</current_date>\n  <timezone>Asia/Shanghai</timezone>\n</environment_context>"
	timeCtx := "<codex_apps_client_time_context><timezone>UTC</timezone><local_time>t</local_time></codex_apps_client_time_context>"
	body, _ := json.Marshal(map[string]any{
		"model": "m",
		"input": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": env}, map[string]any{"type": "input_text", "text": env}},
				"internal_chat_message_metadata_passthrough": map[string]any{"content_item_kinds": []any{environmentContextKind, "user.text"}}},
			map[string]any{"role": "developer", "content": []any{map[string]any{"type": "input_text", "text": timeCtx}}},
			map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": env}}},
		},
		"tools": []any{map[string]any{"type": "web_search", "user_location": map[string]any{"type": "approximate", "country": "CN"}}, map[string]any{"type": "function", "name": "f"}, map[string]any{"type": "web_search_preview"}},
	})
	out := string(alignRequestLocation(body, &location))
	var parsed struct {
		Input []struct {
			Content []struct{ Text string } `json:"content"`
		} `json:"input"`
		Tools []map[string]any `json:"tools"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatal(err)
	}
	if want := strings.Replace(env, "Asia/Shanghai", "Asia/Tokyo", 1); parsed.Input[0].Content[0].Text != want {
		t.Fatalf("environment context=%q", parsed.Input[0].Content[0].Text)
	}
	if parsed.Input[0].Content[1].Text != env || parsed.Input[2].Content[0].Text != env {
		t.Fatal("content labelled as user text or assistant output was rewritten")
	}
	if !strings.Contains(parsed.Input[1].Content[0].Text, "<timezone>Asia/Tokyo</timezone><local_time>t</local_time>") {
		t.Fatalf("desktop time context=%q", parsed.Input[1].Content[0].Text)
	}
	want := map[string]any{"type": "approximate", "country": "JP", "region": "Tokyo", "city": "Chiyoda", "timezone": "Asia/Tokyo"}
	for _, index := range []int{0, 2} {
		got, _ := json.Marshal(parsed.Tools[index]["user_location"])
		expected, _ := json.Marshal(want)
		if string(got) != string(expected) {
			t.Fatalf("tool %d user_location=%s", index, got)
		}
	}
	if _, ok := parsed.Tools[1]["user_location"]; ok {
		t.Fatal("non-search tool received a location")
	}
	before, _ := decodeOrdered(body)
	after, _ := decodeOrdered([]byte(out))
	if strings.Join(before.(*orderedObject).keys, ",") != strings.Join(after.(*orderedObject).keys, ",") {
		t.Fatalf("field order changed: %s", out[:40])
	}
	plain := []byte(`{"model":"m","input":"hi"}`)
	if string(alignRequestLocation(plain, &location)) != string(plain) || string(alignRequestLocation(body, nil)) != string(body) {
		t.Fatal("bodies without location targets must stay byte-identical")
	}

	global := &RequestLocation{Country: "US", Region: "Ohio", City: "Piketon", Timezone: "America/New_York"}
	if requestLocationFor(Account{RequestLocation: &location}, global) != global {
		t.Fatal("a proxy location applies only when the account uses that proxy")
	}
	if requestLocationFor(Account{ProxyURL: "socks5://p:1", RequestLocation: &location}, global) != &location {
		t.Fatal("the proxy location wins over the global location")
	}
}

func TestExecuteAlignsGlobalAndProxyLocation(t *testing.T) {
	var sent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		sent = string(decompressed(r, raw))
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"id":"resp_1"}`)
	}))
	defer upstream.Close()
	server, httpServer, cfg := newExecuteServer(t, upstream.URL, Account{ID: "a", Enabled: true, AccessToken: "tok", Groups: []string{"1"}})
	body := json.RawMessage(`{"model":"gpt-test","input":[{"role":"user","content":[{"type":"input_text","text":"<environment_context><timezone>Asia/Shanghai</timezone></environment_context>"}]}],"tools":[{"type":"web_search"}]}`)
	response := signedExecute(t, cfg, httpServer.URL, Envelope{Dispatch: "d_loc", RequestID: "r_loc", Nonce: "loc", Operation: "responses", Protocol: "openai.responses", Model: "gpt-test", Body: body, Scope: Scope{GroupIDs: []int64{1}},
		RequestLocation: &RequestLocation{Country: "US", Region: "Ohio", City: "Piketon", Timezone: "America/New_York"}})
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(sent, "<timezone>America/New_York</timezone>") || !strings.Contains(sent, `"user_location":{"type":"approximate","country":"US","region":"Ohio","city":"Piketon","timezone":"America/New_York"}`) {
		t.Fatalf("status=%d sent=%s", response.StatusCode, sent)
	}
	if _, err := server.store.Patch("a", map[string]any{"request_location": map[string]any{"country": "DE", "region": "Hesse", "city": "Frankfurt", "timezone": "Europe/Berlin"}}); err != nil {
		t.Fatal(err)
	}
	if account, _ := server.store.Get("a"); account.RequestLocation == nil || account.RequestLocation.Timezone != "Europe/Berlin" {
		t.Fatalf("projected location=%+v", account.RequestLocation)
	}
	if _, err := server.store.Patch("a", map[string]any{"request_location": nil}); err != nil {
		t.Fatal(err)
	}
	if account, _ := server.store.Get("a"); account.RequestLocation != nil {
		t.Fatal("null request_location must clear the proxy location")
	}
}

package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func preferenceRun(t *testing.T, scheduling SchedulingPolicy, op string, body string) (*dispatchRun, map[string]any) {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatal(err)
	}
	run := &dispatchRun{envelope: Envelope{Operation: op, ClientScope: "key-1", Scheduling: scheduling, Headers: map[string]string{}}}
	return run, parsed
}

// CPR e3904178：无会话请求用显式 prompt_cache_key，否则用开头消息摘要；调用方范围隔离，同一内容同一键
func TestCachePreferenceDerivation(t *testing.T) {
	const content = `{"model":"m","instructions":"be brief","input":[{"role":"developer","content":"d"},{"role":"user","content":[{"type":"input_text","text":"hello"},{"type":"input_image","image_url":"x"}]},{"role":"assistant","content":"a"}]}`
	run, body := preferenceRun(t, SchedulingPolicy{}, "responses", content)
	key := run.deriveCachePreference(body)
	if key == "" || !strings.Contains(key, contentPreference) {
		t.Fatalf("content key=%q", key)
	}
	// 后续轮次追加的消息、图片块不改变键
	again, body2 := preferenceRun(t, SchedulingPolicy{}, "responses", `{"model":"m","instructions":"be brief","input":[{"role":"developer","content":"d"},{"role":"user","content":"hello"},{"role":"assistant","content":"zzz"},{"role":"user","content":"more"}]}`)
	if got := again.deriveCachePreference(body2); got != key {
		t.Fatalf("follow-up turn changed key: %q vs %q", got, key)
	}
	// 不同开头消息、不同模型、不同调用方得到不同键
	other, body3 := preferenceRun(t, SchedulingPolicy{}, "responses", strings.Replace(content, `"hello"`, `"bye"`, 1))
	if got := other.deriveCachePreference(body3); got == "" || got == key {
		t.Fatalf("different opening message must differ: %q", got)
	}
	// 字符串输入等价于一条 user 消息
	str, body4 := preferenceRun(t, SchedulingPolicy{}, "responses", `{"model":"m","input":"hi"}`)
	asMessage, body5 := preferenceRun(t, SchedulingPolicy{}, "responses", `{"model":"m","input":[{"role":"user","content":"hi"}]}`)
	if a, b := str.deriveCachePreference(body4), asMessage.deriveCachePreference(body5); a == "" || a != b {
		t.Fatalf("string input key=%q message key=%q", a, b)
	}
	// 显式 prompt_cache_key 优先，与正文无关
	keyed, body6 := preferenceRun(t, SchedulingPolicy{}, "responses", `{"model":"m","prompt_cache_key":"pk","input":"a"}`)
	keyedOther, body7 := preferenceRun(t, SchedulingPolicy{}, "responses", `{"model":"m","prompt_cache_key":"pk","input":"b"}`)
	if a, b := keyed.deriveCachePreference(body6), keyedOther.deriveCachePreference(body7); a == "" || a != b || !strings.Contains(a, clientCachePreference) {
		t.Fatalf("cache key preference %q %q", a, b)
	}
}

func TestCachePreferenceSkipsRealIdentity(t *testing.T) {
	const plain = `{"model":"m","input":"hi"}`
	cases := []struct {
		name  string
		prep  func(run *dispatchRun)
		body  string
		op    string
		extra SchedulingPolicy
	}{
		{"relaxed affinity", nil, plain, "responses", SchedulingPolicy{Affinity: "relaxed"}},
		{"envelope session", func(r *dispatchRun) { r.envelope.Scope.SessionID = "s" }, plain, "responses", SchedulingPolicy{}},
		{"session header", func(r *dispatchRun) { r.envelope.Headers["Session-Id"] = "s" }, plain, "responses", SchedulingPolicy{}},
		{"client metadata session", nil, `{"model":"m","input":"hi","client_metadata":{"session_id":"s"}}`, "responses", SchedulingPolicy{}},
		{"continuation", nil, `{"model":"m","input":"hi","previous_response_id":"resp_1"}`, "responses", SchedulingPolicy{}},
		{"descendant thread", func(r *dispatchRun) { r.followOnly = true }, plain, "responses", SchedulingPolicy{}},
		{"guardian", func(r *dispatchRun) { r.guardian = true }, plain, "responses", SchedulingPolicy{}},
		{"pinned account", func(r *dispatchRun) { r.envelope.Scope.RuntimeAccountID = "a" }, plain, "responses", SchedulingPolicy{}},
		{"no caller scope", func(r *dispatchRun) { r.envelope.ClientScope = "" }, plain, "responses", SchedulingPolicy{}},
		{"search operation", nil, plain, "search", SchedulingPolicy{}},
		{"blank first user", nil, `{"model":"m","input":[{"role":"user","content":"  "}]}`, "responses", SchedulingPolicy{}},
		{"no user message", nil, `{"model":"m","input":[{"role":"assistant","content":"a"}]}`, "responses", SchedulingPolicy{}},
	}
	for _, tc := range cases {
		run, body := preferenceRun(t, tc.extra, tc.op, tc.body)
		if tc.prep != nil {
			tc.prep(run)
		}
		if key := run.deriveCachePreference(body); key != "" {
			t.Fatalf("%s: unexpected key %q", tc.name, key)
		}
	}
}

// 优先模式：首选账号忙时分流且不改写偏好；严格模式排队等待首选账号；不同调用方互不影响
func TestCachePreferenceSelection(t *testing.T) {
	pref := func(policy SchedulingPolicy, client string) selectRequest {
		r := req(policy)
		r.ClientScope = client
		r.CachePreference = cachePreferenceKey(contentPreference, "abc")
		return r
	}
	store := scheduleStore(t, limited("a", 1), limited("b", 1))
	var dl time.Time
	first, _ := store.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "preferred"}, "k1"), &dl)
	second, err := store.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "preferred"}, "k1"), &dl)
	if err != nil || second.ID == first.ID {
		t.Fatalf("preferred should spill over: first=%s second=%s err=%v", first.ID, second.ID, err)
	}
	store.ReleaseLease(first.ID, false, "")
	store.ReleaseLease(second.ID, false, "")
	third, _ := store.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "preferred"}, "k1"), &dl)
	if third.ID != first.ID {
		t.Fatalf("preference moved: %s -> %s", first.ID, third.ID)
	}
	store.ReleaseLease(third.ID, false, "")

	strict := scheduleStore(t, limited("a", 1), limited("b", 1))
	var sdl time.Time
	owner, _ := strict.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "strict"}, "k1"), &sdl)
	var sdl2 time.Time
	if _, err := strict.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "strict", WaitTimeoutMS: 100}, "k1"), &sdl2); !errors.Is(err, ErrQueueTimeout) {
		t.Fatalf("strict should wait for %s, got %v", owner.ID, err)
	}
	// 另一个调用方不受该绑定约束
	var sdl3 time.Time
	if other, err := strict.Acquire(context.Background(), pref(SchedulingPolicy{Affinity: "strict"}, "k2"), &sdl3); err != nil || other.ID == owner.ID {
		t.Fatalf("other caller got %s err=%v (owner %s)", other.ID, err, owner.ID)
	}
}

package codexgateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// 统一控制面重构 P5（R5 审查 R5-5）：经 Server 的真实请求验证共享运行态——两个实例共享 Redis，
// 并发上限合计生效、一个实例上的冷却在另一实例生效、BPS 续接跨实例、Redis 停止时照常接单。

func newSharedServer(t *testing.T, upstreamURL string, mr *miniredis.Miniredis, instance string, accounts ...Account) (*Server, *httptest.Server, Config) {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", CredentialBundleKey: "bundle-key", InstanceID: instance,
		UpstreamBaseURL: upstreamURL, BPSBaseURL: upstreamURL + "/bps", UpstreamTransport: "http", RequestTimeoutSec: 5,
		RedisURL: "redis://" + mr.Addr(), MaxWaitingPerAcct: 4}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.shared.Close() })
	for _, account := range accounts {
		if _, err := server.store.Upsert(account); err != nil {
			t.Fatal(err)
		}
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, httpServer, cfg
}

func TestSharedServersCapAccountConcurrencyAcrossInstances(t *testing.T) {
	mr := miniredis.RunT(t)
	var active, peak, total atomic.Int32
	gate := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		now := active.Add(1)
		for {
			old := peak.Load()
			if now <= old || peak.CompareAndSwap(old, now) {
				break
			}
		}
		total.Add(1)
		<-gate
		nativeReply("ok")(w)
		active.Add(-1)
	}))
	defer upstream.Close()
	acct := account("acct", "tok")
	acct.MaxConcurrency = 1
	_, httpA, cfgA := newSharedServer(t, upstream.URL, mr, "gw-a", acct)
	_, httpB, cfgB := newSharedServer(t, upstream.URL, mr, "gw-b", acct)
	var wg sync.WaitGroup
	statuses := make([]int, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		response, _ := runBody(t, cfgA, httpA.URL, `{"model":"gpt-test","stream":true,"input":"a"}`, SchedulingPolicy{})
		statuses[0] = response.StatusCode
	}()
	deadline := time.Now().Add(3 * time.Second)
	for total.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	go func() {
		defer wg.Done()
		response, _ := runBody(t, cfgB, httpB.URL, `{"model":"gpt-test","stream":true,"input":"b"}`, SchedulingPolicy{WaitTimeoutMS: 4000})
		statuses[1] = response.StatusCode
	}()
	time.Sleep(600 * time.Millisecond)
	if total.Load() != 1 {
		t.Fatalf("the second instance must wait for the shared lease: upstream requests=%d", total.Load())
	}
	close(gate)
	wg.Wait()
	if statuses[0] != 200 || statuses[1] != 200 || peak.Load() != 1 || total.Load() != 2 {
		t.Fatalf("statuses=%v peak=%d total=%d", statuses, peak.Load(), total.Load())
	}
}

func TestSharedServersPropagateCooldownFromARealRateLimit(t *testing.T) {
	mr := miniredis.RunT(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"slow down"}}`)
	}))
	defer upstream.Close()
	a, httpA, cfgA := newSharedServer(t, upstream.URL, mr, "gw-a", account("acct", "tok"))
	b, httpB, cfgB := newSharedServer(t, upstream.URL, mr, "gw-b", account("acct", "tok"))
	_, _ = runBody(t, cfgA, httpA.URL, `{"model":"gpt-test","stream":true,"input":"a"}`, SchedulingPolicy{})
	if got, _ := a.store.Get("acct"); !got.CooldownUntil.After(time.Now()) {
		t.Fatalf("the rate limit must cool the account down on the first instance: %+v", got.CooldownUntil)
	}
	a.store.holds.sync(time.Now(), true)
	b.store.holds.sync(time.Now(), true)
	before := calls.Load()
	response, _ := runBody(t, cfgB, httpB.URL, `{"model":"gpt-test","stream":true,"input":"b"}`, SchedulingPolicy{WaitTimeoutMS: 1})
	if response.StatusCode == http.StatusOK || calls.Load() != before {
		t.Fatalf("the other instance must not use the cooled account: status=%d upstream calls %d -> %d", response.StatusCode, before, calls.Load())
	}
}

func TestSharedServersContinueABPSResponseOnAnotherInstance(t *testing.T) {
	mr := miniredis.RunT(t)
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){
		"bps_tok_a": {bpsTextReply("resp_first", "first answer"), bpsTextReply("resp_second", "second answer")},
	})
	_, httpA, cfgA := newSharedServer(t, server.URL, mr, "gw-a", bpsAccount("a", "tok_a"))
	_, httpB, cfgB := newSharedServer(t, server.URL, mr, "gw-b", bpsAccount("a", "tok_a"))
	response, body := runScoped(t, cfgA, httpA.URL, `{"model":"gpt-test","stream":true,"input":"first question"}`)
	if response.StatusCode != 200 || !strings.Contains(string(body), "resp_first") {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	response, body = runScoped(t, cfgB, httpB.URL, `{"model":"gpt-test","stream":true,"previous_response_id":"resp_first","input":"second question"}`)
	if response.StatusCode != 200 {
		t.Fatalf("continuation on another instance: status=%d body=%s", response.StatusCode, body)
	}
	sent := string(upstream.bodies["bps_tok_a"])
	if !strings.Contains(sent, "first question") || !strings.Contains(sent, "first answer") || strings.Contains(sent, "previous_response_id") {
		t.Fatalf("the other instance must expand the shared snapshot: %s", sent)
	}
}

func TestSharedServerServesRequestsWhileRedisIsDown(t *testing.T) {
	mr := miniredis.RunT(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		nativeReply("ok")(w)
	}))
	defer upstream.Close()
	acct := account("acct", "tok")
	acct.MaxConcurrency = 1
	a, httpA, cfgA := newSharedServer(t, upstream.URL, mr, "gw-a", acct)
	mr.Close()
	for i := 0; i < 3; i++ {
		if response, body := runBody(t, cfgA, httpA.URL, `{"model":"gpt-test","stream":true,"input":"x"}`, SchedulingPolicy{}); response.StatusCode != 200 {
			t.Fatalf("request %d while redis is down: status=%d body=%s", i, response.StatusCode, body)
		}
	}
	if a.shared.usable() {
		t.Fatal("the shared state must report redis as unavailable")
	}
	if status := a.store.leases.status(); status["held"] != 0 || status["untokened"] != 0 {
		t.Fatalf("finished requests must not leave leases behind: %v", status)
	}
}

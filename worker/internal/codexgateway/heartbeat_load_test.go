package codexgateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 心跳上报瞬时在途、两次心跳之间的峰值与各账号在途（控制面据此展示并发，不再只有采样瞬间的值）。
func TestHeartbeatReportsPeakConcurrencyAndAccountInflight(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"), account("b", "tok_b"))
	var mu sync.Mutex
	var beats []map[string]any
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		mu.Lock()
		beats = append(beats, payload)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer control.Close()
	gw.cfg.ControlPlaneURL = control.URL
	beat := func() map[string]any {
		t.Helper()
		mu.Lock()
		before := len(beats)
		mu.Unlock()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { gw.registrationLoop(ctx); close(done) }()
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
			mu.Lock()
			n := len(beats)
			mu.Unlock()
			if n > before {
				break
			}
		}
		cancel()
		<-done
		mu.Lock()
		defer mu.Unlock()
		if len(beats) <= before {
			t.Fatal("no heartbeat")
		}
		return beats[before]
	}
	for i := 0; i < 3; i++ {
		if !gw.acquireCapacity() {
			t.Fatal("capacity")
		}
	}
	atomic.AddInt64(&gw.active, -2)
	gw.store.mu.Lock()
	a := gw.store.accounts["a"]
	a.InFlight, a.GuardianInFlight = 1, 1
	gw.store.accounts["a"] = a
	gw.store.mu.Unlock()

	first := beat()
	if first["active_concurrency"] != 1.0 || first["peak_concurrency"] != 3.0 {
		t.Fatalf("active=%v peak=%v", first["active_concurrency"], first["peak_concurrency"])
	}
	inflight, _ := first["account_inflight"].([]any)
	if len(inflight) != 1 || inflight[0].(map[string]any)["account_id"] != "a" || inflight[0].(map[string]any)["in_flight"] != 2.0 {
		t.Fatalf("account_inflight=%v", first["account_inflight"])
	}
	// 峰值上报后从当前在途重新计
	if second := beat(); second["peak_concurrency"] != 1.0 {
		t.Fatalf("peak not reset: %v", second["peak_concurrency"])
	}
}

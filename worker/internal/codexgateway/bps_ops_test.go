package codexgateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBPSPauseReportsRecoveryAndCooldowns(t *testing.T) {
	now := time.Now()
	account := bpsAccount("a", "tok_a")
	account.BPSSettings.AutoRecoverOn403 = true
	account.BPSSettings.RecoveryIntervalMinutes = 30
	account.BPS.State, account.BPS.BlockedAt = bpsStateBlocked, now.Add(-10*time.Minute)
	account.BPS.PolicyBackoff = map[string]bpsBackoff{"gpt-test": {Until: now.Add(2 * time.Minute), Strikes: 2}}
	account.BPS.ScopedCooldowns = map[string]time.Time{"model:gpt-test": now.Add(5 * time.Minute), "endpoint:responses": now.Add(-time.Minute)}
	pause := account.bpsPause(now)
	next, _ := time.Parse(time.RFC3339Nano, pause["bps_next_probe_at"].(string))
	cooldown, _ := time.Parse(time.RFC3339Nano, pause["bps_cooldown_until"].(string))
	if pause["bps_recovery"] != "auto" || next.Sub(now) < 19*time.Minute || next.Sub(now) > 21*time.Minute || cooldown.Sub(now) < 4*time.Minute {
		t.Fatalf("pause=%v", pause)
	}
	account.BPS.RecoveryStopped = true
	if pause := account.bpsPause(now); pause["bps_recovery"] != "stopped" || pause["bps_next_probe_at"] != nil {
		t.Fatalf("pause=%v", pause)
	}
}

func TestBPSManualUnblockAndStopRecovery(t *testing.T) {
	account := bpsAccount("a", "tok_a")
	account.BPSSettings.AutoRecoverOn403 = true
	s, httpServer, cfg := newBPSExecuteServer(t, "http://127.0.0.1:1", account)
	s.store.DisposeBPS("a", "gpt-test", upstreamFailure{Category: categoryBanned, Status: 403, bps: true}, time.Now())
	if a, _ := s.store.Get("a"); a.BPS.State != bpsStateBlocked {
		t.Fatalf("grant=%+v", a.BPS)
	}
	if response, _ := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/accounts/a/bps/recovery/stop", map[string]any{}); response.StatusCode != 200 {
		t.Fatalf("stop status=%d", response.StatusCode)
	}
	a, _ := s.store.Get("a")
	if !a.BPS.RecoveryStopped {
		t.Fatalf("grant=%+v", a.BPS)
	}
	// 停止后不再探测（无上游也不会发请求）
	s.probeBlockedBPS(t.Context(), time.Now().Add(48*time.Hour))
	if a, _ = s.store.Get("a"); !a.BPS.ProbedAt.IsZero() {
		t.Fatal("stopped recovery must not probe")
	}
	s.store.DisposeBPS("a", "gpt-test", upstreamFailure{Category: categoryRateLimited, Status: 429, bps: true}, time.Now())
	if response, _ := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/accounts/a/bps/unblock", map[string]any{}); response.StatusCode != 200 {
		t.Fatalf("unblock status=%d", response.StatusCode)
	}
	if a, _ = s.store.Get("a"); a.BPS.State != "" || a.BPS.RecoveryStopped || !a.BPS.CooldownUntil.IsZero() || !a.BPS.BlockedAt.IsZero() || a.BPS.AccessToken != "bps_tok_a" {
		t.Fatalf("grant=%+v", a.BPS)
	}
	if states := s.store.credentialStates(); len(states) != 0 {
		t.Fatalf("an unblocked grant must not be reported: %v", states)
	}
}

// 明文凭据接口已删除（P3.9）：控制面改读凭据库或解开导出的凭据包
func TestPlaintextCredentialsEndpointIsGone(t *testing.T) {
	_, httpServer, cfg := newBPSExecuteServer(t, "http://127.0.0.1:1", bpsAccount("a", "tok_a"))
	response, out := signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/accounts/a/credentials", nil)
	if response.StatusCode == http.StatusOK || strings.Contains(fmt.Sprint(out), "tok_a") {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
}

func TestKeyRoutePolicyForcesTheChannel(t *testing.T) {
	upstream, server := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"bps_tok_a": {bpsTextReply("rb", "from bps")}, "tok_a": {nativeReply("native")}})
	_, httpServer, cfg := newBPSExecuteServer(t, server.URL, bpsAccount("a", "tok_a"))
	response, body := runBody(t, cfg, httpServer.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyNativeOnly})
	if response.StatusCode != 200 || upstream.count("bps_tok_a") != 0 || upstream.count("tok_a") != 1 {
		t.Fatalf("native_only: status=%d body=%s", response.StatusCode, body)
	}
	// bps_only：模型不在 BPS 名单时不回退原生
	other, otherServer := newBPSUpstream(t, map[string][]func(http.ResponseWriter){"tok_b": {nativeReply("native")}})
	_, otherHTTP, otherCfg := newBPSExecuteServer(t, otherServer.URL, bpsAccount("b", "tok_b", "gpt-other"))
	response, body = runBody(t, otherCfg, otherHTTP.URL, bpsTextRequest, SchedulingPolicy{BPSEnabled: true, RoutePolicy: routePolicyBPSOnly})
	if response.StatusCode != 503 || other.count("tok_b") != 0 {
		t.Fatalf("bps_only: status=%d native=%d body=%s", response.StatusCode, other.count("tok_b"), body)
	}
	if !json.Valid(body) || !strings.Contains(string(body), "codex_route_basispoints_required") {
		t.Fatalf("body=%s", body)
	}
}

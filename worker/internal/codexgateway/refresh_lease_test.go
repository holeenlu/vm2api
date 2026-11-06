package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeLeaseControlPlane 记录 Worker 发来的租约请求，并校验内部签名。
type fakeLeaseControlPlane struct {
	mu       sync.Mutex
	requests []map[string]any
	paths    []string
	acquire  func(body map[string]any) (int, string)
	release  func(body map[string]any) (int, string)
}

func newFakeLeaseControlPlane(t *testing.T) (*fakeLeaseControlPlane, *httptest.Server) {
	t.Helper()
	cp := &fakeLeaseControlPlane{acquire: func(map[string]any) (int, string) {
		return 200, `{"ok":true,"granted":true,"lease_token":"lt_1"}`
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Kin-Gateway-Token") != "secret" || Verify("secret", r.Header.Get("X-Kin-Gateway-Timestamp"), r.Header.Get("X-Kin-Gateway-Nonce"), r.Header.Get("X-Kin-Gateway-Body-Sha256"), r.Header.Get("X-Kin-Gateway-Signature"), raw, time.Now(), time.Minute) != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		cp.mu.Lock()
		cp.requests = append(cp.requests, body)
		cp.paths = append(cp.paths, r.URL.Path)
		cp.mu.Unlock()
		status, reply := 200, `{"ok":true}`
		if strings.HasSuffix(r.URL.Path, "/credentials/lease") {
			status, reply = cp.acquire(body)
		}
		if strings.HasSuffix(r.URL.Path, "/credentials/release") && cp.release != nil {
			status, reply = cp.release(body)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(server.Close)
	return cp, server
}

func (cp *fakeLeaseControlPlane) snapshot() ([]string, []map[string]any) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return append([]string(nil), cp.paths...), append([]map[string]any(nil), cp.requests...)
}

func newLeaseServer(t *testing.T, tokenURL, controlURL string) *Server {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), InternalToken: "secret", InstanceID: "gw-1", OAuthTokenURL: tokenURL, RequestTimeoutSec: 5}
	cfg.applyDefaults()
	gw, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	gw.cfg.ControlPlaneURL = controlURL + "/internal/v1/gateway/workers/heartbeat"
	return gw
}

func TestNativeRefreshTakesAndReleasesTheLeaseOnlyWhenRequired(t *testing.T) {
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","refresh_token":"rt_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	cp, control := newFakeLeaseControlPlane(t)
	gw := newLeaseServer(t, tokenServer.URL, control.URL)
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_old"
	_, _ = gw.store.Upsert(acct)
	before, _ := gw.store.Get("a")

	// 未下发策略（旧版控制面）：不申请租约
	if _, err := gw.refreshNow(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if paths, _ := cp.snapshot(); len(paths) != 0 {
		t.Fatalf("no lease without the policy, got %v", paths)
	}
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true}}}`))
	current, _ := gw.store.Get("a")
	saved, err := gw.refreshNow(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	paths, requests := cp.snapshot()
	if len(paths) != 2 || paths[0] != "/internal/v1/gateway/workers/credentials/lease" || paths[1] != "/internal/v1/gateway/workers/credentials/release" {
		t.Fatalf("paths=%v", paths)
	}
	acquire, release := requests[0], requests[1]
	if acquire["grant"] != "native" || acquire["instance_id"] != "gw-1" || acquire["runtime_account_id"] != "a" || acquire["credential_revision"].(float64) != float64(current.CredentialRevision) || acquire["token_fingerprint"] != tokenFingerprint("rt_new") {
		t.Fatalf("acquire=%v", acquire)
	}
	if release["outcome"] != "rotated" || release["lease_token"] != "lt_1" || release["credential_revision"].(float64) != float64(saved.CredentialRevision) || release["token_fingerprint"] != tokenFingerprint("rt_new") || saved.CredentialRevision != current.CredentialRevision+1 {
		t.Fatalf("release=%v saved=%d", release, saved.CredentialRevision)
	}
	if strings.Contains(release["token_fingerprint"].(string), "rt_new") || before.CredentialRevision >= saved.CredentialRevision {
		t.Fatal("fingerprints must not contain the token")
	}
	// 策略关闭后恢复原行为
	gw.applyHeartbeatPolicy([]byte(`{"policy":{}}`))
	_, _ = gw.refreshNow(context.Background(), "a")
	if paths, _ := cp.snapshot(); len(paths) != 2 {
		t.Fatalf("lease must stop when the policy is withdrawn: %v", paths)
	}
	if refreshes.Load() != 3 {
		t.Fatalf("refreshes=%d", refreshes.Load())
	}
}

func TestDeniedLeaseWaitsForProjectionAndNeverUsesTheRefreshToken(t *testing.T) {
	previous := refreshLeaseWaitCap
	refreshLeaseWaitCap = 600 * time.Millisecond
	defer func() { refreshLeaseWaitCap = previous }()
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshes.Add(1)
		w.WriteHeader(500)
	}))
	defer tokenServer.Close()
	cp, control := newFakeLeaseControlPlane(t)
	cp.acquire = func(map[string]any) (int, string) {
		return 409, `{"ok":false,"granted":false,"reason":"lease_held","holder":"gw-2"}`
	}
	gw := newLeaseServer(t, tokenServer.URL, control.URL)
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true}}}`))
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_old"
	acct.ExpiresAt = time.Now().Add(-time.Hour)
	_, _ = gw.store.Upsert(acct)
	stale, _ := gw.store.Get("a")

	// 投影在等待期间送来新凭据：直接采用
	go func() {
		time.Sleep(150 * time.Millisecond)
		projected := stale
		projected.AccessToken, projected.RefreshToken, projected.CredentialRevision = "tok_projected", "rt_projected", stale.CredentialRevision+1
		_, _ = gw.store.Upsert(projected)
	}()
	saved, err := gw.refreshNow(context.Background(), "a")
	if err != nil || saved.AccessToken != "tok_projected" {
		t.Fatalf("saved=%q err=%v", saved.AccessToken, err)
	}
	// 没有投影：本次失败，但不判过期，也不调用上游
	_, err = gw.refreshNow(context.Background(), "a")
	if !errors.Is(err, errRefreshLeaseDenied) {
		t.Fatalf("err=%v", err)
	}
	// 控制面不可达：同样不刷新
	cp.acquire = func(map[string]any) (int, string) { return 500, `{"error":{"code":"boom"}}` }
	gw.refresher.failures = map[string]*refreshBackoff{}
	if _, err = gw.refreshNow(context.Background(), "a"); !errors.Is(err, errRefreshLeaseUnavailable) {
		t.Fatalf("err=%v", err)
	}
	current, _ := gw.store.Get("a")
	if refreshes.Load() != 0 || current.CredentialState != "" {
		t.Fatalf("refreshes=%d state=%q", refreshes.Load(), current.CredentialState)
	}
	if paths, _ := cp.snapshot(); len(paths) != 3 || strings.HasSuffix(paths[len(paths)-1], "/release") {
		t.Fatalf("a denied lease is never released: %v", paths)
	}
}

func TestBPSRefreshReportsFingerprintsAndTerminalOutcome(t *testing.T) {
	status := 200
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status == 200 {
			_, _ = io.WriteString(w, `{"access_token":"bps_new","refresh_token":"bps_rt_new","expires_in":3600}`)
		}
	}))
	defer tokenServer.Close()
	cp, control := newFakeLeaseControlPlane(t)
	gw := newLeaseServer(t, tokenServer.URL, control.URL)
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true}}}`))
	_, _ = gw.store.Upsert(bpsAccount("a", "tok_a"))
	if err := gw.refreshBPS(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	_, requests := cp.snapshot()
	// BPS 的代次是令牌代次：刷新前 0，刷新后 1（授权代次 Revision 不变）
	if len(requests) != 2 || requests[0]["grant"] != "bps" || requests[0]["token_fingerprint"] != tokenFingerprint("bps_rt_tok_a") || requests[0]["credential_revision"].(float64) != 0 {
		t.Fatalf("acquire=%v", requests)
	}
	if requests[1]["outcome"] != "rotated" || requests[1]["token_fingerprint"] != tokenFingerprint("bps_rt_new") || requests[1]["credential_revision"].(float64) != 1 || requests[1]["previous_revision"].(float64) != 0 {
		t.Fatalf("release=%v", requests[1])
	}
	status = 401
	if err := gw.refreshBPS(context.Background(), "a"); err == nil {
		t.Fatal("expected BPS refresh failure")
	}
	_, requests = cp.snapshot()
	if last := requests[len(requests)-1]; last["outcome"] != "terminal" || last["token_fingerprint"] != nil {
		t.Fatalf("terminal release=%v", last)
	}
}

func TestControlPlaneEndpointSharesTheRegistrationDirectory(t *testing.T) {
	gw := &Server{cfg: Config{ControlPlaneURL: "https://cp.example/internal/v1/gateway/workers/register?x=1"}}
	if endpoint, ok := gw.controlPlaneEndpoint("credentials/lease"); !ok || endpoint != "https://cp.example/internal/v1/gateway/workers/credentials/lease" {
		t.Fatalf("endpoint=%q", endpoint)
	}
	if _, ok := (&Server{}).controlPlaneEndpoint("credentials/lease"); ok {
		t.Fatal("no control plane, no endpoint")
	}
}

func TestScheduledRefreshOnlyTouchesDesignatedAccounts(t *testing.T) {
	var refreshed sync.Map
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		refreshed.Store(string(body), true)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	_, control := newFakeLeaseControlPlane(t)
	gw := newLeaseServer(t, tokenServer.URL, control.URL)
	for _, id := range []string{"a", "b"} {
		acct := account(id, "tok_"+id)
		acct.RefreshToken = "rt_" + id
		acct.ExpiresAt = time.Now().Add(time.Minute)
		_, _ = gw.store.Upsert(acct)
	}
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true,"designated":["a"]}}}`))
	if !gw.scheduledRefreshAllowed("a") || gw.scheduledRefreshAllowed("b") {
		t.Fatal("only designated accounts are refreshed on schedule")
	}
	if n := gw.refreshDueAccounts(context.Background(), time.Now()); n != 1 {
		t.Fatalf("refreshed=%d", n)
	}
	// 指派缺省（旧版控制面）或租约关闭：不限制
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true}}}`))
	if !gw.scheduledRefreshAllowed("b") {
		t.Fatal("missing designation must not restrict")
	}
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":false,"designated":[]}}}`))
	if !gw.scheduledRefreshAllowed("b") {
		t.Fatal("lease off must not restrict")
	}
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true,"designated":[]}}}`))
	if gw.scheduledRefreshAllowed("a") {
		t.Fatal("an empty designation means nothing is refreshed on schedule here")
	}
}

// 换票请求已发出却没拿到响应：报告 ambiguous，不当作可立即重试的失败（R3 审查 P1-4）
func TestRefreshSentWithoutResponseIsReportedAmbiguous(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		hijacker, _ := w.(http.Hijacker)
		conn, _, _ := hijacker.Hijack()
		_ = conn.Close()
	}))
	defer tokenServer.Close()
	cp, control := newFakeLeaseControlPlane(t)
	gw := newLeaseServer(t, tokenServer.URL, control.URL)
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":true}}}`))
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_old"
	_, _ = gw.store.Upsert(acct)
	if _, err := gw.refreshNow(context.Background(), "a"); !errors.Is(err, errRefreshAmbiguous) {
		t.Fatalf("err=%v", err)
	}
	_, requests := cp.snapshot()
	if last := requests[len(requests)-1]; last["outcome"] != "ambiguous" {
		t.Fatalf("release=%v", last)
	}
	// 连不上（请求没发出）仍是普通失败
	gw.cfg.OAuthTokenURL = "http://127.0.0.1:1/oauth/token"
	gw.refresher.failures = map[string]*refreshBackoff{}
	if _, err := gw.refreshNow(context.Background(), "a"); err == nil || errors.Is(err, errRefreshAmbiguous) {
		t.Fatalf("connection refused must be a plain failure: %v", err)
	}
	_, requests = cp.snapshot()
	if last := requests[len(requests)-1]; last["outcome"] != "failed" {
		t.Fatalf("release=%v", last)
	}
}

// 结果报告失败时在后台重试，每次单独计时，不阻塞刷新路径（R3 复审 M3）
func TestFailedLeaseReleaseRetriesInTheBackground(t *testing.T) {
	cp, control := newFakeLeaseControlPlane(t)
	var calls atomic.Int32
	cp.release = func(map[string]any) (int, string) {
		if calls.Add(1) == 1 {
			return http.StatusServiceUnavailable, `{"ok":false}`
		}
		return http.StatusOK, `{"ok":true}`
	}
	gw := newLeaseServer(t, "http://127.0.0.1:1", control.URL)
	started := time.Now()
	gw.releaseRefreshLease("acct", refreshGrantNative, "lt_1", "failed", 0, "", leaseRotation{})
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("release blocked the caller for %v", elapsed)
	}
	deadline := time.Now().Add(5 * time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if calls.Load() != 2 {
		t.Fatalf("release attempts=%d", calls.Load())
	}
}

// 启动后、收到第一份心跳策略之前（策略未知）不裸刷新；最近一次策略落盘并在重启后沿用（终审 B1）
func TestUnknownLeasePolicyNeverRefreshesWithoutALease(t *testing.T) {
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"tok_new","refresh_token":"rt_new","expires_in":3600}`)
	}))
	defer tokenServer.Close()
	cp, control := newFakeLeaseControlPlane(t)
	dataDir := t.TempDir()
	start := func() *Server {
		cfg := Config{DataDir: dataDir, InternalToken: "secret", InstanceID: "gw-1", OAuthTokenURL: tokenServer.URL, RequestTimeoutSec: 5, ControlPlaneURL: control.URL + "/internal/v1/gateway/workers/heartbeat"}
		cfg.applyDefaults()
		gw, err := NewServer(cfg)
		if err != nil {
			t.Fatal(err)
		}
		return gw
	}
	gw := start()
	acct := account("a", "tok_old")
	acct.RefreshToken = "rt_old"
	_, _ = gw.store.Upsert(acct)
	if gw.scheduledRefreshAllowed("a") {
		t.Fatal("scheduled refresh must wait for the first heartbeat policy")
	}
	// 控制面还不认识本实例：拿不到租约，不换票
	cp.acquire = func(map[string]any) (int, string) {
		return http.StatusNotFound, `{"ok":false,"error":{"code":"gateway_instance_not_found","message":"实例未注册"}}`
	}
	if _, err := gw.refreshNow(context.Background(), "a"); err == nil || refreshes.Load() != 0 {
		t.Fatalf("an unknown policy must not refresh without a lease: err=%v refreshes=%d", err, refreshes.Load())
	}
	// 旧版控制面没有租约接口（普通 404）：照旧自行刷新
	cp.acquire = func(map[string]any) (int, string) {
		return http.StatusNotFound, `{"error":{"message":"not found"}}`
	}
	if _, err := gw.refreshNow(context.Background(), "a"); err != nil || refreshes.Load() != 1 {
		t.Fatalf("an old control plane without leases: err=%v refreshes=%d", err, refreshes.Load())
	}
	// 控制面授予租约：经租约刷新
	cp.acquire = func(map[string]any) (int, string) { return 200, `{"ok":true,"granted":true,"lease_token":"lt_1"}` }
	if _, err := gw.refreshNow(context.Background(), "a"); err != nil || refreshes.Load() != 2 {
		t.Fatalf("leased refresh: err=%v refreshes=%d", err, refreshes.Load())
	}
	// 心跳下发“不需要租约”后落盘；重启后请求内刷新沿用（不申请租约），定时刷新仍等本次启动的第一份策略（PF.2 复核 N2）
	gw.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":false}}}`))
	restarted := start()
	if !restarted.leaseOff() {
		t.Fatal("the saved policy must survive a restart")
	}
	if restarted.scheduledRefreshAllowed("a") {
		t.Fatal("scheduled refresh waits for this boot's first heartbeat policy")
	}
	restarted.applyHeartbeatPolicy([]byte(`{"policy":{"refresh_lease":{"required":false}}}`))
	if !restarted.scheduledRefreshAllowed("a") {
		t.Fatal("scheduled refresh resumes once the policy arrives")
	}
	// 新版控制面带错误码的 404（如账号绑定不存在）不是旧版本：策略未知时不自行刷新（PF.2 复核 N1）
	unknown := gw
	unknown.refreshLease.Store(leasePolicyUnknown)
	cp.acquire = func(map[string]any) (int, string) {
		return http.StatusNotFound, `{"ok":false,"code":"account_binding_not_found"}`
	}
	before := refreshes.Load()
	if _, err := unknown.refreshNow(context.Background(), "a"); err == nil || refreshes.Load() != before {
		t.Fatalf("a coded 404 must not be treated as an old control plane: err=%v", err)
	}
}

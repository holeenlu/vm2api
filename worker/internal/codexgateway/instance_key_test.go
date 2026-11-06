package codexgateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// signWith 按控制面的方式给发往 Worker 的请求签名：keyID 为空时用共用令牌。
func signWith(t *testing.T, method, target, secret, instanceID, keyID string, body []byte) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, target, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce, _ := randomURLToken(12)
	hash := BodyHash(body)
	req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
	req.Header.Set("X-Kin-Gateway-Nonce", nonce)
	req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
	if keyID != "" {
		req.Header.Set("X-Kin-Gateway-Signature", SignV2(secret, method, req.URL.RequestURI(), instanceID, keyID, timestamp, nonce, hash, body))
		req.Header.Set("X-Kin-Gateway-Key", keyID)
		req.Header.Set("X-Kin-Gateway-Instance", instanceID)
	} else {
		req.Header.Set("X-Kin-Gateway-Signature", Sign(secret, timestamp, nonce, hash, body))
		req.Header.Set("X-Kin-Gateway-Key", "default")
	}
	return req
}

func doStatus(t *testing.T, req *http.Request) int {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestInstanceKeyFileIsSealedAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	keys, err := loadInstanceKeys(dir, "gw-1", "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	if keys.held() {
		t.Fatal("a fresh data dir has no instance key")
	}
	secret := strings.Repeat("a", 64)
	if err := keys.install(instanceKeyEntry{KeyID: "ik_1", Secret: secret}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, instanceKeyFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("instance key file mode %v", info.Mode().Perm())
	}
	raw, _ := os.ReadFile(path)
	if !bytes.HasPrefix(raw, []byte(instanceKeySealPrefix)) || bytes.Contains(raw, []byte(secret)) {
		t.Fatalf("instance key file must be sealed: %q", raw)
	}
	// 重启后沿用；凭据包密钥不对时拒绝启动，不静默回到共用令牌
	again, err := loadInstanceKeys(dir, "gw-1", "bundle-key")
	if err != nil {
		t.Fatal(err)
	}
	if id, got, ok := again.signing(); !ok || id != "ik_1" || got != secret {
		t.Fatalf("restart lost the key: %v %v", id, ok)
	}
	if _, err := loadInstanceKeys(dir, "gw-1", "other-key"); err == nil {
		t.Fatal("a sealed key file with the wrong bundle key must not load")
	}
	// 文件属于别的实例 ID 时忽略
	other, err := loadInstanceKeys(dir, "gw-2", "bundle-key")
	if err != nil || other.held() {
		t.Fatalf("a key issued to another instance must be ignored: %v", err)
	}
	// 换上新密钥：上一把保留到宽限期结束
	until := time.Now().Add(time.Minute)
	if err := again.install(instanceKeyEntry{KeyID: "ik_2", Secret: strings.Repeat("b", 64)}, until); err != nil {
		t.Fatal(err)
	}
	if _, ok := again.lookup("ik_1", time.Now()); !ok {
		t.Fatal("the previous key stays valid during the grace period")
	}
	if _, ok := again.lookup("ik_1", until.Add(time.Second)); ok {
		t.Fatal("the previous key expires after the grace period")
	}
	reloaded, _ := loadInstanceKeys(dir, "gw-1", "bundle-key")
	if id, _, _ := reloaded.signing(); id != "ik_2" {
		t.Fatalf("restart after rotation uses %q", id)
	}
	if _, ok := reloaded.lookup("ik_1", time.Now()); !ok {
		t.Fatal("the previous key survives a restart within the grace period")
	}
	if err := reloaded.drop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("dropping the key removes the file")
	}
}

func TestWorkerAcceptsOnlyItsInstanceKeyOnceIssued(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), InternalToken: "shared", InstanceID: "gw-1", CredentialBundleKey: "bundle"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	// 未签发：共用令牌照旧
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/drain", "shared", "", "", []byte(`{}`))); status != 200 {
		t.Fatalf("shared token before issuance: %d", status)
	}
	key := strings.Repeat("c", 64)
	if err := server.instanceKeys.install(instanceKeyEntry{KeyID: "ik_1", Secret: key}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	// 引导期：控制面还没确认这把密钥，仍用共用令牌调用 Worker
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/resume", "shared", "", "", []byte(`{}`))); status != 200 {
		t.Fatalf("shared token before the control plane confirmed the key, got %d", status)
	}
	server.instanceKeys.markConfirmed()
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/resume", "shared", "", "", []byte(`{}`))); status != 401 {
		t.Fatalf("shared token after confirmation must be rejected, got %d", status)
	}
	// 只读探测仍可用共用令牌（scripts/codex-gateway-health.mjs）
	if status := doStatus(t, signWith(t, "GET", ts.URL+"/internal/v1/health", "shared", "", "", nil)); status != 200 {
		t.Fatalf("health probe with the shared token: %d", status)
	}
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/resume", key, "gw-1", "ik_1", []byte(`{}`))); status != 200 {
		t.Fatalf("instance key: %d", status)
	}
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/resume", key, "gw-2", "ik_1", []byte(`{}`))); status != 401 {
		t.Fatalf("a request signed for another instance must be rejected, got %d", status)
	}
	if status := doStatus(t, signWith(t, "POST", ts.URL+"/internal/v1/resume", "forged", "gw-1", "ik_1", []byte(`{}`))); status != 401 {
		t.Fatalf("forged signature: %d", status)
	}
	// 轮换后上一把在宽限期内仍被接受，事件页响应用验证请求的那把密钥签名
	next := strings.Repeat("d", 64)
	if err := server.instanceKeys.install(instanceKeyEntry{KeyID: "ik_2", Secret: next}, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	req := signWith(t, "GET", ts.URL+"/internal/v1/events?after=0", key, "gw-1", "ik_1", nil)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("previous key within grace: %d %s", resp.StatusCode, data)
	}
	want := Sign(key, responseSignatureScope(200, "/internal/v1/events?after=0"), req.Header.Get("X-Kin-Gateway-Nonce"), BodyHash(data), data)
	if resp.Header.Get("X-Kin-Gateway-Response-Signature") != want {
		t.Fatal("the response must be signed with the key that verified the request")
	}
}

// wrapForTest 与控制面 wrapDeliveredSecret 相同：用持有方的秘密包裹下发的新密钥
func wrapForTestNoT(holder, instanceID, keyID, nonce, secret string) string {
	key, _ := hkdf.Key(sha256.New, []byte(holder), []byte("kin-gateway-key-delivery"), "v1\n"+instanceID+"\n"+keyID, 32)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	_, _ = rand.Read(iv)
	return base64.RawURLEncoding.EncodeToString(append(iv, gcm.Seal(nil, iv, []byte(secret), []byte(instanceID+"\n"+keyID+"\n"+nonce))...))
}

// cpReply 是假控制面的一次响应：signer 为空时不签名；"key:<id>" 用实例密钥签名，"bootstrap"/"shared" 用对应秘密
type cpReply struct {
	status int
	body   map[string]any
	signer string
	// deliver 非空时把这把密钥用签名所用的秘密包裹后放进 instance_key
	deliver *instanceKeyEntry
	prev    string
}

// fakeControlPlane 记录每次注册的签名方式与正文，按脚本回复；像控制面一样给响应签名并包裹新密钥。
type fakeControlPlane struct {
	mu       sync.Mutex
	requests []http.Header
	bodies   []map[string]any
	shared   string
	keys     map[string]string // key_id → secret（假控制面知道的实例密钥）
	reply    func(n int, header http.Header, body map[string]any) cpReply
}

func (f *fakeControlPlane) handler(w http.ResponseWriter, r *http.Request) {
	data, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	f.mu.Lock()
	f.requests = append(f.requests, r.Header.Clone())
	f.bodies = append(f.bodies, body)
	n := len(f.requests)
	f.mu.Unlock()
	out := f.reply(n, r.Header, body)
	secret, label := "", ""
	switch {
	case strings.HasPrefix(out.signer, "key:"):
		label = strings.TrimPrefix(out.signer, "key:")
		secret = f.keys[label]
	case out.signer == "bootstrap":
		label, secret = "bootstrap", body["bootstrap_token"].(string)
	case out.signer == "shared":
		label, secret = "shared", f.shared
	}
	nonce := r.Header.Get("X-Kin-Gateway-Nonce")
	if out.deliver != nil {
		delivery := map[string]any{"instance_id": "gw-1", "key_id": out.deliver.KeyID, "wrapped": wrapForTestNoT(secret, "gw-1", out.deliver.KeyID, nonce, out.deliver.Secret)}
		if out.prev != "" {
			delivery["previous_key_id"] = out.prev
			delivery["previous_expires_at"] = time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
		}
		out.body["instance_key"] = delivery
		f.keys[out.deliver.KeyID] = out.deliver.Secret
	}
	text, _ := json.Marshal(out.body)
	if secret != "" {
		hash := BodyHash(text)
		w.Header().Set("X-Kin-Gateway-Response-Key", label)
		w.Header().Set("X-Kin-Gateway-Response-Sha256", hash)
		w.Header().Set("X-Kin-Gateway-Response-Signature", Sign(secret, responseSignatureScope(out.status, r.URL.RequestURI()), nonce, hash, text))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(out.status)
	_, _ = w.Write(text)
}

func TestRegistrationBootstrapsWithTheOneTimeTokenRotatesAndReusesTheKey(t *testing.T) {
	first := &instanceKeyEntry{KeyID: "ik_1", Secret: strings.Repeat("e", 64)}
	second := &instanceKeyEntry{KeyID: "ik_2", Secret: strings.Repeat("f", 64)}
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		ok := map[string]any{"ok": true}
		switch n {
		case 1:
			// 引导：用一次性引导令牌签名并包裹
			return cpReply{status: 200, body: ok, signer: "bootstrap", deliver: first}
		case 3:
			return cpReply{status: 200, body: ok, signer: "key:ik_1", deliver: second, prev: "ik_1"}
		default:
			return cpReply{status: 200, body: ok, signer: "key:" + header.Get("X-Kin-Gateway-Key")}
		}
	}
	cp := httptest.NewServer(http.HandlerFunc(fake.handler))
	t.Cleanup(cp.Close)
	dir := t.TempDir()
	cfg := Config{DataDir: dir, InternalToken: "shared", InstanceID: "gw-1", CredentialBundleKey: "bundle", ControlPlaneURL: cp.URL + "/internal/v1/gateway/workers/register", BootstrapToken: "boot-token"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	rejected := false
	if !server.registerOnce(&rejected) {
		t.Fatal("installing the bootstrap key asks for an immediate heartbeat")
	}
	if fake.bodies[0]["bootstrap_token"] != "boot-token" || fake.bodies[0]["instance_key_support"] != float64(instanceKeySupport) {
		t.Fatalf("bootstrap registration must present the one-time token: %v", fake.bodies[0])
	}
	if server.currentBootstrapToken() != "" {
		t.Fatal("the bootstrap token is used once")
	}
	if !server.instanceKeys.acceptsSharedToken() {
		t.Fatal("until the control plane accepted the key, the shared token still works")
	}
	for i := 0; i < 3; i++ {
		server.registerOnce(&rejected)
	}
	if server.instanceKeys.acceptsSharedToken() {
		t.Fatal("once the control plane accepted a key-signed heartbeat, the shared token is rejected")
	}
	verify := func(n int, keyID string) {
		t.Helper()
		header := fake.requests[n]
		if keyID == "" {
			if header.Get("X-Kin-Gateway-Token") != "shared" || header.Get("X-Kin-Gateway-Instance") != "" {
				t.Fatalf("request %d must use the shared token: %v", n, header)
			}
			return
		}
		if header.Get("X-Kin-Gateway-Token") != "" || fake.bodies[n]["bootstrap_token"] != nil {
			t.Fatalf("request %d must not send the shared or bootstrap token once a key is held", n)
		}
		if header.Get("X-Kin-Gateway-Key") != keyID || header.Get("X-Kin-Gateway-Instance") != "gw-1" {
			t.Fatalf("request %d signed with %q, want %q", n, header.Get("X-Kin-Gateway-Key"), keyID)
		}
	}
	verify(0, "")
	verify(1, "ik_1")
	verify(2, "ik_1")
	verify(3, "ik_2")
	restartCfg := cfg
	restartCfg.BootstrapToken = ""
	restarted, err := NewServer(restartCfg)
	if err != nil {
		t.Fatal(err)
	}
	if restarted.instanceKeys.acceptsSharedToken() {
		t.Fatal("the confirmation survives a restart")
	}
	restarted.registerOnce(&rejected)
	verify(4, "ik_2")

	// 未签名的 401 不删除密钥（可能是伪造或迟到的响应）
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		return cpReply{status: 401, body: map[string]any{"ok": false, "error": map[string]string{"code": "instance_key_invalid"}}}
	}
	if restarted.registerOnce(&rejected) || !restarted.instanceKeys.held() {
		t.Fatal("an unsigned rejection must not drop the key")
	}
	// 已验签的吊销：删除本地密钥并立即重新注册（没有引导令牌，回到共用令牌）
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		if header.Get("X-Kin-Gateway-Key") == "ik_2" {
			return cpReply{status: 401, body: map[string]any{"ok": false, "error": map[string]string{"code": "instance_key_invalid"}}, signer: "key:ik_2"}
		}
		return cpReply{status: 200, body: map[string]any{"ok": true, "instance_key_status": "instance_key_bootstrap_not_allowed"}, signer: "shared"}
	}
	if !restarted.registerOnce(&rejected) {
		t.Fatal("a signed revocation asks for an immediate re-registration")
	}
	restarted.registerOnce(&rejected)
	verify(len(fake.requests)-1, "")
	if restarted.instanceKeys.held() {
		t.Fatal("the revoked key is removed")
	}
	if _, err := os.Stat(filepath.Join(dir, instanceKeyFileName)); !os.IsNotExist(err) {
		t.Fatal("the revoked key file is removed")
	}
}

func TestDeliveredKeyMustBeSignedAndWrapped(t *testing.T) {
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	plain := strings.Repeat("9", 64)
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		switch n {
		case 1: // 没有签名：不接受
			return cpReply{status: 200, body: map[string]any{"ok": true, "instance_key": map[string]any{"instance_id": "gw-1", "key_id": "ik_x", "wrapped": "AAAA"}}}
		case 2: // 签名正确但包裹用的不是持有的秘密：解不开
			return cpReply{status: 200, body: map[string]any{"ok": true, "instance_key": map[string]any{"instance_id": "gw-1", "key_id": "ik_x", "wrapped": wrapForTestNoT("other", "gw-1", "ik_x", header.Get("X-Kin-Gateway-Nonce"), plain)}}, signer: "shared"}
		default: // 共用令牌签名并包裹（管理员授权的引导）：接受
			return cpReply{status: 200, body: map[string]any{"ok": true}, signer: "shared", deliver: &instanceKeyEntry{KeyID: "ik_ok", Secret: plain}}
		}
	}
	cp := httptest.NewServer(http.HandlerFunc(fake.handler))
	t.Cleanup(cp.Close)
	cfg := Config{DataDir: t.TempDir(), InternalToken: "shared", InstanceID: "gw-1", CredentialBundleKey: "bundle", ControlPlaneURL: cp.URL + "/internal/v1/gateway/workers/register"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	rejected := false
	server.registerOnce(&rejected)
	server.registerOnce(&rejected)
	if server.instanceKeys.held() {
		t.Fatal("an unsigned or badly wrapped delivery must be ignored")
	}
	server.registerOnce(&rejected)
	if id, secret, ok := server.instanceKeys.signing(); !ok || id != "ik_ok" || secret != plain {
		t.Fatalf("a signed, wrapped delivery is installed: %v %v", id, ok)
	}
}

// 审查 P1-1：迟到的、针对旧密钥的 401 不能删掉刚换上的新密钥；instance_key_required 与
// instance_key_bootstrap_not_allowed 只记日志、不删可用密钥。
func TestStaleRejectionsDoNotDropTheCurrentKey(t *testing.T) {
	keys, err := loadInstanceKeys(t.TempDir(), "gw-a", "")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{cfg: Config{InstanceID: "gw-a"}, instanceKeys: keys}
	if err := keys.install(instanceKeyEntry{KeyID: "ik_new", Secret: strings.Repeat("b", 64)}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	invalid := []byte(`{"ok":false,"error":{"code":"instance_key_invalid"}}`)
	if s.handleInstanceKeyRejection(401, invalid, controlCall{keyID: "ik_old"}, true) || !keys.held() {
		t.Fatal("a late rejection for the old key must not drop the new key")
	}
	for _, code := range []string{"instance_key_required", "instance_key_bootstrap_not_allowed"} {
		if s.handleInstanceKeyRejection(401, []byte(`{"ok":false,"error":{"code":"`+code+`"}}`), controlCall{keyID: "ik_new"}, true) || !keys.held() {
			t.Fatalf("%s must not drop a usable key", code)
		}
	}
	if !s.handleInstanceKeyRejection(401, invalid, controlCall{keyID: "ik_new"}, true) || keys.held() {
		t.Fatal("a verified rejection of the current key drops it")
	}
}

func TestConfigRejectsInvalidInstanceIDs(t *testing.T) {
	for _, id := range []string{"gw 1", "-gw", "gw/1", strings.Repeat("a", 65)} {
		cfg := Config{DataDir: t.TempDir(), InternalToken: "x", InstanceID: id}
		cfg.applyDefaults()
		if err := cfg.Validate(); err == nil {
			t.Fatalf("instance id %q must be rejected", id)
		}
	}
	cfg := Config{DataDir: t.TempDir(), InternalToken: "x", InstanceID: "  gw-01 "}
	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil || cfg.InstanceID != "gw-01" {
		t.Fatalf("surrounding spaces are trimmed: %v %q", err, cfg.InstanceID)
	}
}

func newRegisteringServer(t *testing.T, fake *fakeControlPlane, bootstrap string) (*Server, Config) {
	t.Helper()
	cp := httptest.NewServer(http.HandlerFunc(fake.handler))
	t.Cleanup(cp.Close)
	cfg := Config{DataDir: t.TempDir(), InternalToken: "shared", InstanceID: "gw-1", CredentialBundleKey: "bundle", ControlPlaneURL: cp.URL + "/internal/v1/gateway/workers/register", BootstrapToken: bootstrap}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return server, cfg
}

// 复审 P1-2：持有引导令牌却连续被拒（例如控制面重启后旧令牌失效）时退出，由托管器换发新令牌；未签名的拒绝不计数
func TestBootstrapRefusalsRestartTheWorker(t *testing.T) {
	signer := ""
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		return cpReply{status: 401, body: map[string]any{"ok": false, "error": map[string]string{"code": "instance_key_required"}}, signer: signer}
	}
	server, _ := newRegisteringServer(t, fake, "boot-token")
	exits := 0
	server.requestExit = func() { exits++ }
	rejected := false
	for i := 0; i < 4; i++ {
		server.registerOnce(&rejected)
	}
	if exits != 0 {
		t.Fatal("unsigned refusals must not restart the Worker")
	}
	signer = "shared"
	for i := 0; i < 3; i++ {
		server.registerOnce(&rejected)
	}
	if exits != 1 {
		t.Fatalf("three verified refusals restart the Worker once, got %d", exits)
	}
	// on 模式下 200 + instance_key_bootstrap_not_allowed 同样计数
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		return cpReply{status: 200, body: map[string]any{"ok": true, "instance_key_status": "instance_key_bootstrap_not_allowed"}, signer: "shared"}
	}
	server.bootstrapRefusals.Store(0)
	for i := 0; i < 3; i++ {
		server.registerOnce(&rejected)
	}
	if exits != 2 {
		t.Fatalf("bootstrap_not_allowed responses count too, got %d exits", exits)
	}
	// 没有引导令牌的外部 Worker 只记日志、不退出
	plain, _ := newRegisteringServer(t, fake, "")
	plain.requestExit = func() { exits++ }
	for i := 0; i < 5; i++ {
		plain.registerOnce(&rejected)
	}
	if exits != 2 {
		t.Fatal("Workers without a bootstrap token never exit on refusals")
	}
}

// 复审 P1-2：控制面已提交签发但 Worker 没收到响应、或落盘失败——同一子进程带着同一令牌重试，拿到新密钥后恢复
func TestBootstrapRetriesWithTheSameTokenAfterALostResponse(t *testing.T) {
	key := &instanceKeyEntry{KeyID: "ik_2", Secret: strings.Repeat("7", 64)}
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		if n == 1 {
			// 签发了，但响应在路上丢了（这里用一个解不开的包裹模拟落盘/接收失败）
			return cpReply{status: 200, body: map[string]any{"ok": true, "instance_key": map[string]any{"instance_id": "gw-1", "key_id": "ik_1", "wrapped": "AAAA"}}, signer: "bootstrap"}
		}
		if body["bootstrap_token"] != "boot-token" {
			t.Errorf("retry %d must present the same token: %v", n, body["bootstrap_token"])
		}
		return cpReply{status: 200, body: map[string]any{"ok": true}, signer: "bootstrap", deliver: key}
	}
	server, _ := newRegisteringServer(t, fake, "boot-token")
	rejected := false
	server.registerOnce(&rejected)
	if server.instanceKeys.held() || server.currentBootstrapToken() == "" {
		t.Fatal("a failed install keeps the token for a retry")
	}
	server.registerOnce(&rejected)
	if id, _, ok := server.instanceKeys.signing(); !ok || id != "ik_2" {
		t.Fatalf("the retry installs the re-issued key: %v %v", id, ok)
	}
}

// 复审 P2-2：持有实例密钥时只采信验签通过的响应；旧版控制面（共用令牌、完全不带签名头）按兼容处理
func TestUnverifiedResponsesDoNotApplyPolicy(t *testing.T) {
	policy := func(rev int64) map[string]any {
		return map[string]any{"ok": true, "policy": map[string]any{"settings_revision": rev}}
	}
	mode := "unsigned"
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		switch mode {
		case "bad":
			return cpReply{status: 200, body: policy(2), signer: "key:missing"}
		case "key":
			return cpReply{status: 200, body: policy(4), signer: "key:" + header.Get("X-Kin-Gateway-Key")}
		}
		return cpReply{status: 200, body: policy(1)}
	}
	server, _ := newRegisteringServer(t, fake, "")
	rejected := false
	server.registerOnce(&rejected)
	if server.settingsRevision.Load() != 1 {
		t.Fatal("an old control plane without signatures still works on the shared token path")
	}
	mode = "bad"
	fake.keys["missing"] = "wrong-secret"
	server.registerOnce(&rejected)
	if server.settingsRevision.Load() != 1 {
		t.Fatal("a response with an invalid signature is ignored")
	}
	_ = server.instanceKeys.install(instanceKeyEntry{KeyID: "ik_h", Secret: strings.Repeat("h", 64)}, time.Time{})
	fake.keys["ik_h"] = strings.Repeat("h", 64)
	mode = "unsigned"
	server.registerOnce(&rejected)
	if server.settingsRevision.Load() != 1 {
		t.Fatal("with an instance key, unsigned responses are never applied")
	}
	mode = "key"
	server.registerOnce(&rejected)
	if server.settingsRevision.Load() != 4 {
		t.Fatal("a verified response is applied")
	}
	// 租约：持有密钥时未签名的批准被当作控制面不可达
	mode = "unsigned"
	if _, _, err := server.postControlPlane(context.Background(), "credentials/lease", map[string]any{}); err == nil {
		t.Fatal("an unsigned lease response must be rejected")
	}
	mode = "key"
	if status, _, err := server.postControlPlane(context.Background(), "credentials/lease", map[string]any{}); err != nil || status != 200 {
		t.Fatalf("a signed lease response is accepted: %v %v", status, err)
	}
}

// 复审 P2-3：出示了引导令牌时，只接受引导令牌签名的响应（共用令牌签名、用共用令牌包裹的密钥不装）
func TestBootstrapCallOnlyTrustsBootstrapSignedKeys(t *testing.T) {
	key := &instanceKeyEntry{KeyID: "ik_s", Secret: strings.Repeat("s", 64)}
	signer := "shared"
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		return cpReply{status: 200, body: map[string]any{"ok": true}, signer: signer, deliver: key}
	}
	server, _ := newRegisteringServer(t, fake, "boot-token")
	rejected := false
	server.registerOnce(&rejected)
	if server.instanceKeys.held() {
		t.Fatal("a key signed and wrapped with the shared token must be ignored while presenting a bootstrap token")
	}
	signer = "bootstrap"
	server.registerOnce(&rejected)
	if !server.instanceKeys.held() {
		t.Fatal("a bootstrap-signed delivery is installed")
	}
}

// 第三轮复审 P1-A：off 模式下控制面不签发密钥；托管 Worker 带着引导令牌也要能应用（共用令牌或引导令牌签名的）策略
func TestSupervisedWorkerAppliesPolicyWhenKeysAreOff(t *testing.T) {
	signer := "shared"
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		return cpReply{status: 200, body: map[string]any{"ok": true, "instance": map[string]any{"id": "gw-1"}, "policy": map[string]any{"settings_revision": n}}, signer: signer}
	}
	server, _ := newRegisteringServer(t, fake, "boot-token")
	exits := 0
	server.requestExit = func() { exits++ }
	rejected := false
	server.registerOnce(&rejected)
	if server.settingsRevision.Load() != 1 {
		t.Fatal("a shared-signed policy is applied while presenting a bootstrap token")
	}
	signer = "bootstrap"
	for i := 0; i < 4; i++ {
		server.registerOnce(&rejected)
	}
	if server.settingsRevision.Load() != 5 || exits != 0 || server.instanceKeys.held() {
		t.Fatalf("bootstrap-signed policy applies without keys or restarts: rev=%d exits=%d", server.settingsRevision.Load(), exits)
	}
}

// 第三轮复审 P2-4：拒绝计数严格连续，中间有正常响应就清零
func TestBootstrapRefusalsMustBeConsecutive(t *testing.T) {
	refuse := true
	fake := &fakeControlPlane{shared: "shared", keys: map[string]string{}}
	fake.reply = func(n int, header http.Header, body map[string]any) cpReply {
		if refuse {
			return cpReply{status: 401, body: map[string]any{"ok": false, "error": map[string]string{"code": "instance_key_required"}}, signer: "bootstrap"}
		}
		return cpReply{status: 200, body: map[string]any{"ok": true, "instance": map[string]any{"id": "gw-1"}}, signer: "bootstrap"}
	}
	server, _ := newRegisteringServer(t, fake, "boot-token")
	exits := 0
	server.requestExit = func() { exits++ }
	rejected := false
	for _, r := range []bool{true, true, false, true, true, false, true} {
		refuse = r
		server.registerOnce(&rejected)
	}
	if exits != 0 {
		t.Fatalf("refusals separated by successes must not restart the Worker, got %d", exits)
	}
	refuse = true
	server.registerOnce(&rejected)
	server.registerOnce(&rejected)
	if exits != 1 {
		t.Fatalf("three consecutive refusals restart the Worker, got %d", exits)
	}
}

// 第三轮复审 P2-2：只有带登记或策略的响应才算心跳送达（续接只回密钥、待批准只回状态）
func TestHeartbeatAcceptedNeedsInstanceOrPolicy(t *testing.T) {
	cases := map[string]bool{
		`{"ok":true,"instance":{"id":"gw-1"}}`:                          true,
		`{"ok":true,"policy":{"settings_revision":1}}`:                  true,
		`{"ok":true,"instance_key":{"key_id":"ik_2"}}`:                  false,
		`{"ok":true,"instance_key_status":"instance_pending_approval"}`: false,
		`{"ok":true,"instance":null}`:                                   false,
	}
	for body, want := range cases {
		if got := heartbeatAccepted([]byte(body)); got != want {
			t.Fatalf("%s: got %v", body, got)
		}
	}
}

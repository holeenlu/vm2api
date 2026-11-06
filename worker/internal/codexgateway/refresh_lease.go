package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// 凭据刷新租约（统一控制面重构 P3.2，设计第 6 节；控制面实现见 src/lib/executor/refresh-lease.mjs）。
//
// OpenAI 的刷新令牌一次性轮换：多个 Worker 持有同一账号副本时各自刷新，只有第一个成功，其余副本的令牌随即失效。
// 控制面心跳策略下发 refresh_lease.required（KIN_REFRESH_LEASE=on）时，刷新原生或 BPS 授权前先向控制面申请租约：
//   - 取得租约：刷新后报告结果（rotated / failed / terminal），成功时控制面把新凭据投影到其他实例；
//   - 被拒（其他实例持有租约，或本实例的凭据已过时）：不使用手里的刷新令牌，等待投影送来新凭据（最多到本次刷新的时限）；
//   - 控制面不可达：不刷新（宁可这次失败，也不让多个副本竞争轮换）；这两种情况都不计入“恢复窗口耗尽判过期”。
// 未下发或为假（旧版控制面、单 Worker 部署）时行为与以前相同。

const (
	refreshGrantNative = "native"
	refreshGrantBPS    = "bps"

	refreshLeaseRequestTimeout = 10 * time.Second

	refreshLeasePollInterval = 200 * time.Millisecond
)

// refreshLeaseWaitCap 是租约被拒后等待投影的上限（测试可缩短）
var refreshLeaseWaitCap = 20 * time.Second

var (
	// errRefreshAmbiguous：换票请求已完整发出，却没有拿到响应（超时、断连、读响应失败）。
	// 上游可能已经轮换了刷新令牌，报告 ambiguous，控制面在一段时间内不再向任何实例发放租约（R3 审查 P1-4）
	errRefreshAmbiguous        = errors.New("refresh outcome unknown: the request was sent but no complete response arrived")
	errRefreshLeaseDenied      = errors.New("refresh lease denied")
	errRefreshLeaseUnavailable = errors.New("refresh lease unavailable")
)

// isRefreshLeaseError：租约被拒或控制面不可达，不是凭据本身的问题。
func isRefreshLeaseError(err error) bool {
	return errors.Is(err, errRefreshLeaseDenied) || errors.Is(err, errRefreshLeaseUnavailable)
}

// tokenFingerprint 是刷新令牌的不可逆短指纹，控制面据此判断副本手里的令牌是否已被其他实例轮换。
func tokenFingerprint(refreshToken string) string {
	if refreshToken == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(refreshToken))
	return hex.EncodeToString(sum[:8])
}

// controlPlaneEndpoint：ControlPlaneURL 指向 /internal/v1/gateway/workers/register（或 heartbeat），其他内部接口与之同目录。
func (s *Server) controlPlaneEndpoint(name string) (string, bool) {
	if strings.TrimSpace(s.cfg.ControlPlaneURL) == "" {
		return "", false
	}
	u, err := url.Parse(s.cfg.ControlPlaneURL)
	if err != nil {
		return "", false
	}
	index := strings.LastIndex(u.Path, "/")
	u.Path = u.Path[:index+1] + name
	u.RawQuery = ""
	return u.String(), true
}

// signControlRequest 按控制面内部接口的约定签名（令牌、时间戳、随机串、正文摘要与 HMAC）。
func (s *Server) signControlRequest(req *http.Request, body []byte) {
	req.Header.Set("Content-Type", "application/json")
	token := s.cfg.ControlPlaneToken
	if token == "" {
		token = s.cfg.InternalToken
	}
	if token == "" {
		return
	}
	req.Header.Set("X-Kin-Gateway-Token", token)
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce, _ := randomURLToken(18)
	hash := BodyHash(body)
	req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
	req.Header.Set("X-Kin-Gateway-Nonce", nonce)
	req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
	req.Header.Set("X-Kin-Gateway-Signature", Sign(token, timestamp, nonce, hash, body))
}

func (s *Server) controlClient(timeout time.Duration) *http.Client {
	client := &http.Client{Timeout: timeout}
	if tlsConfig, err := s.controlTLSConfig(); err == nil && tlsConfig != nil {
		client.Transport = &http.Transport{TLSClientConfig: tlsConfig}
	}
	return client
}

// postControlPlane 向控制面同目录的内部接口发送签名 JSON，返回状态码与正文（上限 64 KiB）。
func (s *Server) postControlPlane(ctx context.Context, name string, payload any) (int, []byte, error) {
	endpoint, ok := s.controlPlaneEndpoint(name)
	if !ok {
		return 0, nil, errors.New("control plane is not configured")
	}
	data, err := marshalJSON(payload)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	s.signControlRequest(req, data)
	resp, err := s.controlClient(refreshLeaseRequestTimeout).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, body, nil
}

// 租约策略三态（终审 B1）：启动后、收到第一份心跳策略之前为“未知”，按需要租约处理：
// 不做定时刷新；请求内刷新先申请租约，控制面明确是不支持租约的旧版本（接口 404）时才自行刷新。
// 最近一次策略写入数据目录，重启后沿用，避免控制面暂时不可达时默认关闭的部署无法刷新。
const (
	leasePolicyUnknown int32 = iota
	leasePolicyOff
	leasePolicyOn
	leasePolicyFileName = "refresh-lease-policy"
)

func (s *Server) initialLeasePolicy() int32 {
	if s.cfg.ControlPlaneURL == "" {
		return leasePolicyOff
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.DataDir, leasePolicyFileName))
	if err != nil {
		return leasePolicyUnknown
	}
	switch strings.TrimSpace(string(raw)) {
	case "on":
		return leasePolicyOn
	case "off":
		return leasePolicyOff
	}
	return leasePolicyUnknown
}

// setLeasePolicy 记录控制面下发的租约策略，变化时落盘。
func (s *Server) setLeasePolicy(required bool) {
	defer s.leasePolicyReceived.Store(true)
	next, value := leasePolicyOff, "off"
	if required {
		next, value = leasePolicyOn, "on"
	}
	if s.refreshLease.Swap(next) != next && s.cfg.DataDir != "" {
		if err := writeFileSynced(filepath.Join(s.cfg.DataDir, leasePolicyFileName), []byte(value+"\n")); err != nil {
			log.Printf("codex-gateway: saving the refresh lease policy failed: %v", err)
		}
	}
}

// leaseOff：控制面明确不要求租约（或未接控制面）。
func (s *Server) leaseOff() bool {
	return s.refreshLease.Load() == leasePolicyOff
}

// acquireRefreshLease：不需要租约时返回空令牌与 nil；被拒返回 errRefreshLeaseDenied，控制面不可达返回 errRefreshLeaseUnavailable。
func (s *Server) acquireRefreshLease(ctx context.Context, accountID, grant string, revision int64, fingerprint string) (string, error) {
	if s.leaseOff() {
		return "", nil
	}
	status, body, err := s.postControlPlane(ctx, "credentials/lease", map[string]any{
		"instance_id":         s.cfg.InstanceID,
		"runtime_account_id":  accountID,
		"grant":               grant,
		"credential_revision": revision,
		"token_fingerprint":   fingerprint,
	})
	if err != nil {
		return "", fmt.Errorf("%w: %v", errRefreshLeaseUnavailable, err)
	}
	var out struct {
		Granted    bool   `json:"granted"`
		LeaseToken string `json:"lease_token"`
		Reason     string `json:"reason"`
		Code       string `json:"code"`
		Error      struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &out)
	if out.Code == "" {
		out.Code = out.Error.Code
	}
	if status == http.StatusOK && out.Granted && out.LeaseToken != "" {
		return out.LeaseToken, nil
	}
	if status == http.StatusConflict {
		return "", fmt.Errorf("%w: %s", errRefreshLeaseDenied, out.Reason)
	}
	// 策略未知时，控制面没有租约接口（旧版本：通用 404，不带任何错误码）：不支持租约，照旧自行刷新。
	// 新版控制面的 404 都带错误码（实例未注册、账号绑定不存在等），不能当成旧版本（PF.2 复核 N1）
	if status == http.StatusNotFound && out.Code == "" && s.refreshLease.Load() == leasePolicyUnknown {
		return "", nil
	}
	reason := out.Code
	if reason == "" {
		reason = out.Reason
	}
	return "", fmt.Errorf("%w: control plane returned %d %s", errRefreshLeaseUnavailable, status, reason)
}

// releaseRefreshLease 报告刷新结果；失败只记日志（租约 60 秒后自然过期）。
// rotated 时附带新凭据包（实例间共享密钥加密）与刷新前的代次 previousRevision，控制面以凭据库托管令牌时据此按代次 CAS 写入新凭据（P3.6）。
func (s *Server) releaseRefreshLease(accountID, grant, leaseToken, outcome string, revision int64, fingerprint string, previousRevision int64) {
	if leaseToken == "" {
		return
	}
	payload := map[string]any{
		"instance_id":        s.cfg.InstanceID,
		"runtime_account_id": accountID,
		"grant":              grant,
		"lease_token":        leaseToken,
		"outcome":            outcome,
	}
	if outcome == "rotated" {
		payload["credential_revision"] = revision
		payload["token_fingerprint"] = fingerprint
		payload["previous_revision"] = previousRevision
		if account, ok := s.store.Get(accountID); ok {
			if bundle, err := s.sealCredentialBundle(account); err == nil {
				payload["credential_bundle"] = bundle
			}
		}
	}
	// 每次发送单独计时：前一次挂起到超时，不会吃掉后面重试的时间（R3 复审 M3）
	send := func() (int, []byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), refreshLeaseRequestTimeout)
		defer cancel()
		return s.postControlPlane(ctx, "credentials/release", payload)
	}
	report := func(status int, body []byte, err error) {
		if err != nil || status != http.StatusOK {
			log.Printf("codex-gateway: refresh lease release for %s/%s failed: status=%d err=%v body=%s", accountID, grant, status, err, strings.TrimSpace(string(body)))
		}
	}
	status, body, err := send()
	if err == nil && status < 500 {
		report(status, body, err)
		return
	}
	// 传输失败或 5xx 时在后台再试两次（结果报告丢失会让控制面与其他实例晚一步拿到新令牌，R3 复审 N7）；
	// 不阻塞请求内的 401 刷新路径
	go func() {
		for attempt := 1; attempt < 3; attempt++ {
			time.Sleep(time.Duration(attempt) * time.Second)
			status, body, err = send()
			if err == nil && status < 500 {
				break
			}
		}
		report(status, body, err)
	}()
}

// awaitCredentialUpdate 在租约被拒后等待投影送来新凭据：changed 为真即返回最新账号。
func (s *Server) awaitCredentialUpdate(ctx context.Context, accountID string, changed func(Account) bool) (Account, bool) {
	deadline := time.Now().Add(refreshLeaseWaitCap)
	if until, ok := ctx.Deadline(); ok && until.Before(deadline) {
		deadline = until
	}
	for {
		if current, ok := s.store.Get(accountID); ok && changed(current) {
			return current, true
		}
		if time.Now().Add(refreshLeasePollInterval).After(deadline) {
			return Account{}, false
		}
		select {
		case <-ctx.Done():
			return Account{}, false
		case <-time.After(refreshLeasePollInterval):
		}
	}
}

// leasedRefresh 用租约包住原生授权的换票（refreshNow 单飞内调用）。
func (s *Server) leasedRefresh(ctx context.Context, accountID string) (Account, error) {
	account, ok := s.store.Get(accountID)
	if !ok || s.leaseOff() {
		return s.doRefresh(ctx, accountID)
	}
	leaseToken, err := s.acquireRefreshLease(ctx, accountID, refreshGrantNative, account.CredentialRevision, tokenFingerprint(account.RefreshToken))
	if err != nil {
		if errors.Is(err, errRefreshLeaseDenied) {
			if updated, ok := s.awaitCredentialUpdate(ctx, accountID, func(current Account) bool {
				return current.CredentialRevision > account.CredentialRevision || current.RefreshToken != account.RefreshToken
			}); ok {
				return updated, nil
			}
		}
		return Account{}, err
	}
	saved, err := s.doRefresh(ctx, accountID)
	s.releaseRefreshLease(accountID, refreshGrantNative, leaseToken, refreshOutcome(err), saved.CredentialRevision, tokenFingerprint(saved.RefreshToken), account.CredentialRevision)
	return saved, err
}

// refreshBPS 用租约包住 BPS 授权的换票（调用方持有 s.bps.refreshMu 或在后台循环内串行调用）。
func (s *Server) refreshBPS(ctx context.Context, accountID string) error {
	account, ok := s.store.Get(accountID)
	if !ok || account.BPS == nil || s.leaseOff() {
		return s.doRefreshBPS(ctx, accountID)
	}
	previous := account.BPS.RefreshToken
	// BPS 的代次用令牌代次（每次刷新递增），控制面据此判断副本是否过时、按代次 CAS 写入凭据库
	leaseToken, err := s.acquireRefreshLease(ctx, accountID, refreshGrantBPS, account.BPS.TokenGeneration, tokenFingerprint(previous))
	if err != nil {
		if errors.Is(err, errRefreshLeaseDenied) {
			if _, ok := s.awaitCredentialUpdate(ctx, accountID, func(current Account) bool {
				return current.BPS != nil && current.BPS.RefreshToken != previous
			}); ok {
				return nil
			}
		}
		return err
	}
	err = s.doRefreshBPS(ctx, accountID)
	outcome := refreshOutcome(err)
	current, _ := s.store.Get(accountID)
	if err != nil && current.BPS != nil && current.BPS.State == bpsStateInvalid {
		outcome = "terminal"
	}
	var revision int64
	fingerprint := ""
	if current.BPS != nil {
		revision, fingerprint = current.BPS.TokenGeneration, tokenFingerprint(current.BPS.RefreshToken)
	}
	s.releaseRefreshLease(accountID, refreshGrantBPS, leaseToken, outcome, revision, fingerprint, account.BPS.TokenGeneration)
	return err
}

// scheduledRefreshAllowed：开启租约且控制面下发了预刷新指派时，定时刷新只处理指派给本实例的账号（P3.3）。
// 其他账号由被指派的实例刷新后投影过来；请求内 401 与手动刷新不受限制。
func (s *Server) scheduledRefreshAllowed(accountID string) bool {
	// 接控制面时，定时刷新一律等本次启动收到的第一份心跳策略（终审 B1）；落盘的策略只用于请求内刷新
	// （例如刚开启租约时重启的 Worker 读到旧的 off，PF.2 复核 N2）
	if s.cfg.ControlPlaneURL != "" && !s.leasePolicyReceived.Load() {
		return false
	}
	if s.refreshLease.Load() != leasePolicyOn {
		return true
	}
	designated := s.refreshDesignated.Load()
	if designated == nil || *designated == nil {
		return true
	}
	return (*designated)[accountID]
}

// traceWritten 记录请求是否已完整写出，用于区分“没发出去”（failed，可立即重试）与“结果不明”（ambiguous）。
// 不经过标准 Transport 的连接拿不到这个信号，按没发出处理（与过去相同）。
func traceWritten(req *http.Request) (*http.Request, *atomic.Bool) {
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			wrote.Store(true)
		}
	}}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace)), &wrote
}

// sentButUnanswered 把“已发出、没拿到完整响应”的错误标成 errRefreshAmbiguous。
func sentButUnanswered(wrote *atomic.Bool, err error) error {
	if err != nil && wrote != nil && wrote.Load() {
		return fmt.Errorf("%w: %v", errRefreshAmbiguous, err)
	}
	return err
}

func refreshOutcome(err error) string {
	switch {
	case err == nil:
		return "rotated"
	case errors.Is(err, errRefreshAmbiguous):
		return "ambiguous"
	case errors.Is(err, errRefreshTerminal):
		return "terminal"
	default:
		return "failed"
	}
}

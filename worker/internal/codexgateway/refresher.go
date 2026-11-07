package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// 对齐 codex-proxy-rs 的 OAuth 刷新策略：提前 5 分钟，并在 [margin, 2×margin] 内按账号稳定错峰；
// 连续失败指数退避（5s×3^n，上限 300s），五次后改为每 10 分钟恢复一次。AT 过期后只在 2 小时恢复窗口内
// 继续刷新，窗口过后仍失败即判过期终态；重试时刻不晚于 AT 过期时刻与窗口截止。凭据只由定时刷新与手动
// 刷新恢复，推理与账号请求不在请求内刷新。
const (
	refreshMargin          = 5 * time.Minute
	refreshScanInterval    = 30 * time.Second
	refreshBackoffBase     = 5 * time.Second
	refreshBackoffFactor   = 3
	refreshBackoffCap      = 300 * time.Second
	refreshBackoffAttempts = 5
	refreshRecoveryDelay   = 10 * time.Minute
	refreshBackoffWindow   = 30 * time.Minute
	// 令牌请求（刷新与授权码交换）的总期限：经代理隧道与 TLS 握手后仍要等响应，30 秒会先于连接完成超时（CPR c73e7126）
	refreshRequestTimeout  = 60 * time.Second
	refreshResponseMaxSize = 64 << 10
	refreshRecoveryWindow  = 2 * time.Hour
)

var errRefreshTerminal = errors.New("refresh token is no longer valid")

type refreshCall struct {
	done    chan struct{}
	account Account
	err     error
}

type refreshBackoff struct {
	failures int
	lastAt   time.Time
	nextAt   time.Time
}

type refresher struct {
	mu       sync.Mutex
	calls    map[string]*refreshCall
	failures map[string]*refreshBackoff
}

func newRefresher() *refresher {
	return &refresher{calls: map[string]*refreshCall{}, failures: map[string]*refreshBackoff{}}
}

// effectiveExpiry 优先使用记录的过期时间，缺失时从 access token 的 JWT exp 推导。
func effectiveExpiry(account Account) time.Time {
	if !account.ExpiresAt.IsZero() {
		return account.ExpiresAt
	}
	if exp, ok := jwtClaims(account.AccessToken)["exp"].(float64); ok && exp > 0 {
		return time.Unix(int64(exp), 0).UTC()
	}
	return time.Time{}
}

func refreshable(account Account) bool {
	if account.APIKey != "" || strings.TrimSpace(account.RefreshToken) == "" {
		return false
	}
	switch account.CredentialState {
	case "invalid", "banned", "unverified":
		return false
	}
	return true
}

// refreshWindowExhausted：AT 已过期超过恢复窗口（CPR refresh_recovery_window_exhausted）。
func refreshWindowExhausted(account Account, now time.Time) bool {
	expiry := effectiveExpiry(account)
	return !expiry.IsZero() && !now.Before(expiry.Add(refreshRecoveryWindow))
}

// refreshStagger 由账号 ID 稳定派生 [0, margin] 的错峰偏移，跨扫描与重启不变。
func refreshStagger(accountID string) time.Duration {
	sum := sha256.Sum256([]byte("refresh-stagger\x00" + accountID))
	seconds := binary.BigEndian.Uint64(sum[:8]) % uint64(refreshMargin/time.Second+1)
	return time.Duration(seconds) * time.Second
}

// refreshDue 只选可用状态的账号（CPR 候选为 unknown/ready）：expired 是终态；AT 过期超过恢复窗口的账号
// 不再列为候选（CPR 查询下界 now-2h），保持不可用直到手动刷新或重新授权。
func refreshDue(account Account, now time.Time) bool {
	if !refreshable(account) || account.CredentialState == "expired" {
		return false
	}
	expiry := effectiveExpiry(account)
	if expiry.IsZero() || !now.Before(expiry.Add(refreshRecoveryWindow)) {
		return false
	}
	return expiry.Sub(now) <= refreshMargin+refreshStagger(account.ID)
}

func (r *refresher) backoffAllows(accountID string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.failures[accountID]
	return state == nil || !now.Before(state.nextAt)
}

// recordFailure 推进退避；下次重试不晚于仍有效的 AT 过期时刻与恢复窗口截止（CPR bounded_refresh_retry_at）。
func (r *refresher) recordFailure(accountID string, expiry, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.failures[accountID]
	if state == nil || now.Sub(state.lastAt) > refreshBackoffWindow {
		state = &refreshBackoff{}
		r.failures[accountID] = state
	}
	state.failures++
	state.lastAt = now
	if state.failures > refreshBackoffAttempts {
		state.nextAt = now.Add(refreshRecoveryDelay)
	} else {
		delay := refreshBackoffBase
		for i := 1; i < state.failures; i++ {
			delay *= refreshBackoffFactor
		}
		state.nextAt = now.Add(min(delay, refreshBackoffCap))
	}
	if !expiry.IsZero() {
		if expiry.After(now) && state.nextAt.After(expiry) {
			state.nextAt = expiry
		}
		if deadline := expiry.Add(refreshRecoveryWindow); state.nextAt.After(deadline) {
			state.nextAt = deadline
		}
	}
}

func (r *refresher) recordSuccess(accountID string) {
	r.mu.Lock()
	delete(r.failures, accountID)
	r.mu.Unlock()
}

// refreshAccount 是账号操作入口（手动刷新、重授权），与自动刷新共用单飞。
func (s *Server) refreshAccount(accountID string) (Account, error) {
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), refreshOperationKey{}, "manual_refresh"), refreshRequestTimeout)
	defer cancel()
	return s.refreshNow(ctx, accountID)
}

type refreshOperationKey struct{}

// refreshOperation：诊断记录的刷新来源（manual_refresh / scheduled_refresh）。
func refreshOperation(ctx context.Context) string {
	if op, _ := ctx.Value(refreshOperationKey{}).(string); op != "" {
		return op
	}
	return "scheduled_refresh"
}

// refreshNow 按账号单飞刷新：并发调用共享同一次换票结果，提交使用凭据代次 CAS。
func (s *Server) refreshNow(ctx context.Context, accountID string) (Account, error) {
	r := s.refresher
	r.mu.Lock()
	if call, ok := r.calls[accountID]; ok {
		r.mu.Unlock()
		select {
		case <-call.done:
			return call.account, call.err
		case <-ctx.Done():
			return Account{}, ctx.Err()
		}
	}
	call := &refreshCall{done: make(chan struct{})}
	r.calls[accountID] = call
	r.mu.Unlock()
	// 换票不随单个请求取消而中断，避免撤销一次已在上游生效的 refresh token 轮换。
	refreshCtx, cancel := context.WithTimeout(context.WithValue(context.Background(), refreshOperationKey{}, refreshOperation(ctx)), refreshRequestTimeout)
	call.account, call.err = s.doRefresh(refreshCtx, accountID)
	if call.err == nil {
		// 刷新结果立即写回凭据库（失败由后台循环重试，facts_write.go）
		s.syncCredentials(refreshCtx, accountID)
	}
	cancel()
	r.mu.Lock()
	delete(r.calls, accountID)
	r.mu.Unlock()
	close(call.done)
	if call.err != nil {
		now := time.Now()
		current, _ := s.store.Get(accountID)
		// 恢复窗口已过仍刷新失败（含瞬态失败）：判过期终态，不再自动刷新（封禁与 RT 终态已由 refreshFailure 记录）
		if !errors.Is(call.err, errRefreshTerminal) && current.CredentialState == "" && refreshWindowExhausted(current, now) {
			_, _ = s.store.SetCredentialState(accountID, "expired", "refresh_recovery_window_exhausted")
		}
		r.recordFailure(accountID, effectiveExpiry(current), now)
	} else {
		r.recordSuccess(accountID)
	}
	select {
	case <-ctx.Done():
		return call.account, ctx.Err()
	default:
	}
	return call.account, call.err
}

func (s *Server) doRefresh(ctx context.Context, accountID string) (Account, error) {
	account, ok := s.store.Get(accountID)
	if !ok {
		return Account{}, os.ErrNotExist
	}
	if strings.TrimSpace(account.RefreshToken) == "" {
		return Account{}, errors.New("refresh token is missing")
	}
	// CPR token_client：JSON 正文 {client_id, grant_type, refresh_token}（不带 scope），画像的 originator 与 UA
	// 及部署配套头，不带 version；总时长 30s，响应上限 64KiB
	payload, _ := json.Marshal(map[string]string{"client_id": s.cfg.ClientID, "grant_type": "refresh_token", "refresh_token": account.RefreshToken})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.OAuthTokenURL, bytes.NewReader(payload))
	if err != nil {
		return Account{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	profile := s.globalProfile()
	req.Header.Set("originator", profile.Originator)
	req.Header.Set("User-Agent", profile.userAgent())
	if profile.Residency != "" {
		req.Header.Set("x-openai-internal-codex-residency", profile.Residency)
	}
	if profile.RoutingOverr != "" {
		req.Header.Set("x-openai-account-routing-override", profile.RoutingOverr)
	}
	client, err := s.clientFor(account)
	if err != nil {
		return Account{}, err
	}
	req, wrote := traceWritten(req)
	resp, err := client.Do(req)
	if err != nil {
		s.store.SetRefreshFailure(account.ID, &RefreshFailure{At: time.Now().UTC(), Operation: refreshOperation(ctx), Message: truncateDiagnostic(err.Error())})
		return Account{}, sentButUnanswered(wrote, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, refreshResponseMaxSize))
	if err != nil {
		return Account{}, fmt.Errorf("%w: %v", errRefreshAmbiguous, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		err := s.refreshFailure(account, resp.StatusCode, data)
		failure := &RefreshFailure{At: time.Now().UTC(), Operation: refreshOperation(ctx), Status: resp.StatusCode, Message: redactRefreshBody(data, account.RefreshToken)}
		var payload struct {
			Error any    `json:"error"`
			Code  string `json:"code"`
		}
		_ = json.Unmarshal(data, &payload)
		failure.Code = payload.Code
		if text, ok := payload.Error.(string); ok && failure.Code == "" {
			failure.Code = text
		} else if object, ok := payload.Error.(map[string]any); ok && failure.Code == "" {
			failure.Code, _ = object["code"].(string)
		}
		s.store.SetRefreshFailure(account.ID, failure)
		return Account{}, err
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &token); err != nil {
		return Account{}, errors.New("invalid oauth refresh response")
	}
	// id_token 存在时必须是可解析的 JWT（不验签），否则视为无效的成功响应
	if token.IDToken != "" && !jwtParsable(token.IDToken) {
		return Account{}, errors.New("oauth refresh returned an invalid id_token")
	}
	s.recordOAuthRecovery("refresh", account.ID, token.AccessToken, token.RefreshToken)
	previousRevision := account.CredentialRevision
	// 缺少的字段保留当前值（CPR persist_success）；过期时间优先取新 AT 的 JWT exp
	var expiresAt time.Time
	if token.AccessToken != "" {
		probe := account
		probe.AccessToken, probe.ExpiresAt = token.AccessToken, time.Time{}
		if expiry := effectiveExpiry(probe); !expiry.IsZero() {
			expiresAt = expiry
		} else if token.ExpiresIn > 0 {
			expiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC()
		}
	}
	// 只提交凭据字段：换票请求最长 30 秒，期间合并进来的库内配置不能被开始时读到的旧快照写回
	saved, err := s.store.CommitCredentials(accountID, previousRevision, func(current *Account) {
		if token.AccessToken != "" {
			current.AccessToken, current.ExpiresAt = token.AccessToken, expiresAt
		}
		if token.RefreshToken != "" {
			current.RefreshToken = token.RefreshToken
		}
		if token.IDToken != "" {
			current.IDToken = token.IDToken
		}
		current.CredentialState = ""
		current.LastRefreshFailure = nil
		current.CredentialRevision = previousRevision + 1
	})
	if err != nil {
		// 期间事实合并换入了库里更新的凭据（重新授权、导入），采用最新值
		if current, ok := s.store.Get(accountID); ok && current.CredentialRevision > previousRevision {
			return current, nil
		}
		return Account{}, err
	}
	if saved.CredentialState == "expired" {
		saved, _ = s.store.SetCredentialState(accountID, "", "")
	}
	return saved, nil
}

// refreshFailure 对齐 CPR token_client：三个明确的 RT 原因与账号停用是终态；不带这些信号的 401 走有界恢复。
func (s *Server) refreshFailure(account Account, status int, body []byte) error {
	code, message := oauthErrorCode(body)
	// 定制差异：CPR 让任何 401 都走有界恢复，但上游撤销授权时回的就是 401 + refresh_token_invalidated
	// （"Your session has ended"），AT 有效期内账号会一直显示可用。明确的终态码与停用消息不论状态码都判终态；
	// 只有不带这些信号的 401 保留 CPR 的有界恢复。
	switch code {
	case "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated":
		_, _ = s.store.SetCredentialState(account.ID, "invalid", code)
		return fmt.Errorf("%w: %s", errRefreshTerminal, code)
	}
	if strings.Contains(strings.ToLower(message), "account has been deactivated") {
		_, _ = s.store.SetCredentialState(account.ID, "banned", "account_deactivated")
		return fmt.Errorf("%w: account deactivated", errRefreshTerminal)
	}
	return fmt.Errorf("oauth refresh returned %d", status)
}

// oauthErrorCode 取 OAuth 令牌端点错误响应里的错误码（小写）与说明：顶层 code / error 字符串 / error 对象。
func oauthErrorCode(body []byte) (string, string) {
	var payload struct {
		Error            any    `json:"error"`
		ErrorDescription string `json:"error_description"`
		Code             string `json:"code"`
		Message          string `json:"message"`
	}
	_ = json.Unmarshal(body, &payload)
	code := strings.ToLower(payload.Code)
	message := payload.Message
	switch value := payload.Error.(type) {
	case string:
		if code == "" {
			code = strings.ToLower(value)
		}
	case map[string]any:
		if text, _ := value["code"].(string); code == "" {
			code = strings.ToLower(text)
		}
		if text, _ := value["message"].(string); message == "" {
			message = text
		}
	}
	if message == "" {
		message = payload.ErrorDescription
	}
	return code, message
}

// refreshLoop 定期扫描进入提前刷新窗口的 OAuth 账号。
func (s *Server) refreshLoop(ctx context.Context) {
	ticker := time.NewTicker(refreshScanInterval)
	defer ticker.Stop()
	for {
		s.refreshDueAccounts(ctx, time.Now())
		// BPS 附加授权单独刷新；403 停用且开启自动恢复的按间隔探测；模型无权冷却按 access 目录提前解除
		s.refreshDueBPS(ctx, time.Now())
		s.probeBlockedBPS(ctx, time.Now())
		s.recoverBPSModels(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) refreshDueAccounts(ctx context.Context, now time.Time) int {
	refreshed := 0
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return refreshed
		}
		// 停用账号同样保持凭据新鲜（CPR 刷新候选只看凭据状态），重新启用后可立即使用
		if !refreshDue(account, now) || !s.refresher.backoffAllows(account.ID, now) {
			continue
		}
		if _, err := s.refreshNow(ctx, account.ID); err == nil {
			refreshed++
		}
	}
	return refreshed
}

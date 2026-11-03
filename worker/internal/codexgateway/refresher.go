package codexgateway

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// 对齐 codex-proxy-rs 的 OAuth 刷新策略：提前 5 分钟，并在 [margin, 2×margin] 内按账号稳定错峰；
// 连续失败指数退避（5s×3^n，上限 300s），五次后改为每 10 分钟恢复一次。
const (
	refreshMargin          = 5 * time.Minute
	refreshScanInterval    = 30 * time.Second
	refreshBackoffBase     = 5 * time.Second
	refreshBackoffFactor   = 3
	refreshBackoffCap      = 300 * time.Second
	refreshBackoffAttempts = 5
	refreshRecoveryDelay   = 10 * time.Minute
	refreshBackoffWindow   = 30 * time.Minute
	refreshRequestTimeout  = 60 * time.Second
	refreshBeforeSendSkew  = 30 * time.Second
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

// needsRefreshBeforeSend：过期（或即将过期、已被上游判过期）的 OAuth 凭据在发送前先刷新。
func needsRefreshBeforeSend(account Account, now time.Time) bool {
	if !refreshable(account) {
		return false
	}
	if account.CredentialState == "expired" {
		return true
	}
	expiry := effectiveExpiry(account)
	return !expiry.IsZero() && expiry.Before(now.Add(refreshBeforeSendSkew))
}

// refreshStagger 由账号 ID 稳定派生 [0, margin] 的错峰偏移，跨扫描与重启不变。
func refreshStagger(accountID string) time.Duration {
	sum := sha256.Sum256([]byte("refresh-stagger\x00" + accountID))
	seconds := binary.BigEndian.Uint64(sum[:8]) % uint64(refreshMargin/time.Second+1)
	return time.Duration(seconds) * time.Second
}

func refreshDue(account Account, now time.Time) bool {
	if !refreshable(account) {
		return false
	}
	if account.CredentialState == "expired" {
		return true
	}
	expiry := effectiveExpiry(account)
	if expiry.IsZero() {
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

func (r *refresher) recordFailure(accountID string, now time.Time) {
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
		return
	}
	delay := refreshBackoffBase
	for i := 1; i < state.failures; i++ {
		delay *= refreshBackoffFactor
	}
	state.nextAt = now.Add(min(delay, refreshBackoffCap))
}

func (r *refresher) recordSuccess(accountID string) {
	r.mu.Lock()
	delete(r.failures, accountID)
	r.mu.Unlock()
}

// refreshAccount 是账号操作入口（手动刷新、重授权），与自动刷新共用单飞。
func (s *Server) refreshAccount(accountID string) (Account, error) {
	ctx, cancel := context.WithTimeout(context.Background(), refreshRequestTimeout)
	defer cancel()
	return s.refreshNow(ctx, accountID)
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
	refreshCtx, cancel := context.WithTimeout(context.Background(), refreshRequestTimeout)
	call.account, call.err = s.doRefresh(refreshCtx, accountID)
	cancel()
	r.mu.Lock()
	delete(r.calls, accountID)
	r.mu.Unlock()
	close(call.done)
	if call.err != nil {
		r.recordFailure(accountID, time.Now())
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
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {account.RefreshToken}, "client_id": {s.cfg.ClientID}, "scope": {s.cfg.OAuthScope}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.OAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Account{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", s.globalProfile().userAgent())
	client, err := s.clientFor(account)
	if err != nil {
		return Account{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return Account{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Account{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Account{}, s.refreshFailure(account, resp.StatusCode, data)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &token); err != nil || token.AccessToken == "" {
		return Account{}, errors.New("oauth refresh response missing access_token")
	}
	previousRevision := account.CredentialRevision
	account.AccessToken = token.AccessToken
	if token.RefreshToken != "" {
		account.RefreshToken = token.RefreshToken
	}
	if token.IDToken != "" {
		account.IDToken = token.IDToken
	}
	account.ExpiresAt = time.Time{}
	if token.ExpiresIn > 0 {
		account.ExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC()
	} else {
		account.ExpiresAt = effectiveExpiry(account)
	}
	account.CredentialState = ""
	account.CredentialRevision = previousRevision + 1
	saved, err := s.store.UpsertCAS(account, previousRevision)
	if err != nil {
		// 其他路径（重授权、投影）已写入更新的凭据，采用最新值
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

// refreshFailure 与 CPR token_client 相同：401 走有界恢复；三个明确的 RT 原因与账号停用是终态。
func (s *Server) refreshFailure(account Account, status int, body []byte) error {
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
	if status != http.StatusUnauthorized {
		switch code {
		case "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated":
			_, _ = s.store.SetCredentialState(account.ID, "invalid", code)
			return fmt.Errorf("%w: %s", errRefreshTerminal, code)
		}
		if strings.Contains(strings.ToLower(message), "account has been deactivated") {
			_, _ = s.store.SetCredentialState(account.ID, "banned", "account_deactivated")
			return fmt.Errorf("%w: account deactivated", errRefreshTerminal)
		}
	}
	return fmt.Errorf("oauth refresh returned %d", status)
}

// refreshLoop 定期扫描进入提前刷新窗口的 OAuth 账号。
func (s *Server) refreshLoop(ctx context.Context) {
	ticker := time.NewTicker(refreshScanInterval)
	defer ticker.Stop()
	for {
		s.refreshDueAccounts(ctx, time.Now())
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
		if !account.Enabled || !refreshDue(account, now) || !s.refresher.backoffAllows(account.ID, now) {
			continue
		}
		if _, err := s.refreshNow(ctx, account.ID); err == nil {
			refreshed++
		}
	}
	return refreshed
}

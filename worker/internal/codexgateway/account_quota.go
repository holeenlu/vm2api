package codexgateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 账号额度查询与主动重置卡（对齐 codex-proxy-rs subscription/reset_credits 与 /wham/usage）。
const (
	accountRequestTimeout = 20 * time.Second
	maxResetCredits       = 100
)

// accountBaseURL 把推理基址 .../backend-api/codex 换成账号接口基址 .../backend-api/wham。
func (s *Server) accountBaseURL() string {
	base := strings.TrimRight(s.cfg.UpstreamBaseURL, "/")
	if strings.HasSuffix(base, "/codex") {
		return strings.TrimSuffix(base, "/codex") + "/wham"
	}
	return base + "/wham"
}

func (s *Server) accountRequest(ctx context.Context, account Account, method, path string, body []byte) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.accountBaseURL()+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	applyAccountIdentity(req.Header, account, s.globalProfile())
	client, err := s.clientFor(account)
	if err != nil {
		return 0, nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, data, err
}

// withAuthRecovery 执行账号请求，401 时单飞刷新后重试一次。
func (s *Server) withAuthRecovery(ctx context.Context, accountID string, call func(Account) (int, []byte, error)) (int, []byte, Account, error) {
	account, ok := s.store.Get(accountID)
	if !ok {
		return 0, nil, Account{}, errAccountNotFound
	}
	if needsRefreshBeforeSend(account, time.Now()) {
		if refreshed, err := s.refreshNow(ctx, accountID); err == nil {
			account = refreshed
		}
	}
	status, data, err := call(account)
	if err == nil && status == http.StatusUnauthorized && refreshable(account) {
		if refreshed, refreshErr := s.refreshNow(ctx, accountID); refreshErr == nil {
			account = refreshed
			status, data, err = call(account)
		}
	}
	return status, data, account, err
}

var errAccountNotFound = errors.New("account not found")

// queryQuota 读取 /wham/usage 与重置卡列表，更新账号额度快照并返回公开视图。
func (s *Server) queryQuota(ctx context.Context, accountID string) (map[string]any, int, error) {
	status, data, account, err := s.withAuthRecovery(ctx, accountID, func(account Account) (int, []byte, error) {
		return s.accountRequest(ctx, account, http.MethodGet, "/usage", nil)
	})
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if status < 200 || status >= 300 {
		failure := classifyHTTPFailure(status, http.Header{}, data, time.Now())
		s.store.Dispose(account.ID, "", failure, time.Now())
		return nil, upstreamStatusForClient(status), fmt.Errorf("usage query returned %d", status)
	}
	var usage map[string]any
	if err := json.Unmarshal(data, &usage); err != nil {
		return nil, http.StatusBadGateway, errors.New("invalid usage response")
	}
	now := time.Now()
	quota := quotaFromUsage(usage, now)
	if plan, ok := usage["plan_type"].(string); ok && plan != "" {
		quota["plan_type"] = plan
	}
	result := map[string]any{"quota": quota, "plan_type": usage["plan_type"], "email": usage["email"]}
	if credits, ok := usage["credits"].(map[string]any); ok {
		result["credits"] = credits
	}
	resetCredits, listErr := s.listResetCredits(ctx, account)
	if listErr == nil {
		result["reset_credits"] = resetCredits
	} else if embedded, ok := usage["rate_limit_reset_credits"].(map[string]any); ok {
		result["reset_credits"] = embedded
		result["warning"] = "reset_credit_list_unavailable"
	}
	// /wham/usage 是完整快照：缺失的窗口要清除旧的响应头观测
	s.store.ReplaceQuota(account.ID, quota)
	return result, http.StatusOK, nil
}

func (s *Server) listResetCredits(ctx context.Context, account Account) (map[string]any, error) {
	status, data, err := s.accountRequest(ctx, account, http.MethodGet, "/rate-limit-reset-credits", nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("reset-credit list returned %d", status)
	}
	var wire struct {
		AvailableCount int              `json:"available_count"`
		Credits        []map[string]any `json:"credits"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return nil, errors.New("invalid reset-credit list response")
	}
	if len(wire.Credits) > maxResetCredits {
		return nil, errors.New("reset-credit list exceeded the item limit")
	}
	credits := make([]map[string]any, 0, len(wire.Credits))
	for _, credit := range wire.Credits {
		item := map[string]any{}
		for _, key := range []string{"id", "expires_at", "status", "reset_type"} {
			if value, ok := credit[key]; ok {
				item[key] = value
			}
		}
		credits = append(credits, item)
	}
	return map[string]any{"available_count": wire.AvailableCount, "credits": credits, "fetched_at": time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

// consumeResetCredit 消费一张主动重置卡。redeem_request_id 由调用方在结果不明时复用，保证上游幂等。
func (s *Server) consumeResetCredit(ctx context.Context, accountID, creditID, redeemID string) (map[string]any, int, error) {
	if redeemID == "" {
		redeemID = newUUIDv4()
	}
	payload := map[string]any{"redeem_request_id": redeemID}
	if creditID != "" {
		payload["credit_id"] = creditID
	}
	body, _ := json.Marshal(payload)
	status, data, account, err := s.withAuthRecovery(ctx, accountID, func(account Account) (int, []byte, error) {
		return s.accountRequest(ctx, account, http.MethodPost, "/rate-limit-reset-credits/consume", body)
	})
	if err != nil {
		// 发送结果不明：把幂等键交还调用方，重试时必须复用
		return map[string]any{"redeem_request_id": redeemID, "outcome": "unknown"}, http.StatusBadGateway, err
	}
	if status < 200 || status >= 300 {
		return map[string]any{"redeem_request_id": redeemID}, upstreamStatusForClient(status), fmt.Errorf("reset-credit consume returned %d", status)
	}
	var wire struct {
		Code         string         `json:"code"`
		Credit       map[string]any `json:"credit"`
		WindowsReset int            `json:"windows_reset"`
	}
	if err := json.Unmarshal(data, &wire); err != nil || wire.Code == "" {
		return map[string]any{"redeem_request_id": redeemID, "outcome": "unknown"}, http.StatusBadGateway, errors.New("invalid reset-credit consume response")
	}
	result := map[string]any{"redeem_request_id": redeemID, "code": wire.Code, "windows_reset": wire.WindowsReset}
	if wire.Credit != nil {
		result["credit"] = wire.Credit
	}
	// 重置成功后解除额度冷却，并读取最新额度
	if wire.WindowsReset > 0 || strings.EqualFold(wire.Code, "ok") || strings.EqualFold(wire.Code, "success") {
		s.store.ClearQuotaCooldown(account.ID)
	}
	if after, _, err := s.queryQuota(ctx, account.ID); err == nil {
		for key, value := range after {
			result[key] = value
		}
	} else {
		result["warning"] = "quota_refresh_failed"
	}
	return result, http.StatusOK, nil
}

func upstreamStatusForClient(status int) int {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests:
		return status
	}
	return http.StatusBadGateway
}

// quotaFromUsage 把 /wham/usage 的 rate_limit 转为与 x-codex-* 头相同的额度结构。
func quotaFromUsage(usage map[string]any, now time.Time) map[string]any {
	rateLimit, _ := usage["rate_limit"].(map[string]any)
	quota := map[string]any{"updated_at": now.UTC().Format(time.RFC3339Nano), "source": "wham_usage"}
	windows := 0
	for wire, key := range map[string]string{"primary_window": "primary_window", "secondary_window": "secondary_window"} {
		raw, ok := rateLimit[wire].(map[string]any)
		if !ok {
			continue
		}
		window := map[string]any{}
		if used, ok := raw["used_percent"].(float64); ok {
			window["used_percent"] = used
		}
		if seconds, ok := raw["limit_window_seconds"].(float64); ok && seconds > 0 {
			window["window_minutes"] = float64(int((seconds + 30) / 60))
		}
		if reset, ok := raw["reset_at"].(float64); ok && reset > 0 {
			if reset > 1e12 {
				reset /= 1000
			}
			window["reset_at"] = time.Unix(int64(reset), 0).UTC().Format(time.RFC3339Nano)
		} else if after, ok := raw["reset_after_seconds"].(float64); ok {
			window["reset_at"] = now.Add(time.Duration(after) * time.Second).UTC().Format(time.RFC3339Nano)
		}
		if after, ok := raw["reset_after_seconds"].(float64); ok {
			window["reset_after_seconds"] = after
		}
		quota[key] = window
		windows++
	}
	if credits, ok := usage["credits"].(map[string]any); ok {
		quota["credits"] = credits
	}
	if plan, ok := usage["plan_type"].(string); ok && plan != "" {
		quota["plan_type"] = plan
	}
	switch windows {
	case 2:
		quota["confidence"] = "complete"
	case 0:
		quota["confidence"] = "unknown"
	default:
		quota["confidence"] = "partial"
	}
	return quota
}

func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// maxQuotaReportsPerHeartbeat 限制单次心跳携带的额度快照数，其余顺延到下一次心跳。
const maxQuotaReportsPerHeartbeat = 200

// quotaReporter 记录已随心跳交给控制面的额度快照指纹：
// 启动后首次上报全部账号，此后只上报额度内容变化的账号（响应头、流内 rate_limits、/wham/usage 都会改写快照）。
type quotaReporter struct {
	mu       sync.Mutex
	reported map[string]string
}

type quotaReport struct {
	AccountID string         `json:"account_id"`
	Quota     map[string]any `json:"quota"`
}

func newQuotaReporter() *quotaReporter { return &quotaReporter{reported: map[string]string{}} }

// pending 返回待上报的快照及其指纹；心跳成功后以 commit 确认。
func (q *quotaReporter) pending(accounts []Account) ([]quotaReport, map[string]string) {
	if q == nil {
		return nil, nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	live := make(map[string]bool, len(accounts))
	var reports []quotaReport
	fingerprints := map[string]string{}
	for _, account := range accounts {
		live[account.ID] = true
		if len(account.Quota) == 0 || len(reports) >= maxQuotaReportsPerHeartbeat {
			continue
		}
		data, err := json.Marshal(account.Quota)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(data)
		fingerprint := hex.EncodeToString(sum[:])
		if q.reported[account.ID] == fingerprint {
			continue
		}
		reports = append(reports, quotaReport{AccountID: account.ID, Quota: account.Quota})
		fingerprints[account.ID] = fingerprint
	}
	for id := range q.reported {
		if !live[id] {
			delete(q.reported, id)
		}
	}
	return reports, fingerprints
}

func (q *quotaReporter) commit(fingerprints map[string]string) {
	if q == nil {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for id, fingerprint := range fingerprints {
		q.reported[id] = fingerprint
	}
}

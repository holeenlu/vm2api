package codexgateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// 后台额度维护（对齐 codex-proxy-rs credential/quota scheduling + warmup、credential/catalog）：
//   - 首查：尚无额度快照的 OAuth 账号在 [0,10min) 随机时点查询 /wham/usage，每轮最多 100 个；
//   - 周期刷新：已耗尽账号在 reset 后 10s 起复核，5 分钟内每 30s、之后每 5 分钟；正常账号仅当有用量的
//     窗口越过 reset+2min 时复核，其余以 30 分钟兜底节流；
//   - 预热：按控制面下发的本地时刻（UTC+8）对 OAuth 账号发起最小请求，激活 5h 窗口；
//   - 套餐目录：按套餐每 15 分钟读取上游模型目录，30 分钟内的目录用于排除套餐不含该模型的账号。
const (
	backgroundTick               = 30 * time.Second
	periodicQuotaRefreshInterval = 30 * time.Minute
	quotaResetFastWindow         = 5 * time.Minute
	quotaResetFastInterval       = 30 * time.Second
	quotaResetRetryInterval      = 5 * time.Minute
	exhaustedQuotaResetGrace     = 10 * time.Second
	quotaResetGrace              = 2 * time.Minute
	initialQuotaSyncBatch        = 100
	initialQuotaSyncMaxDelay     = 10 * time.Minute
	quotaFetch5xxRetries         = 2
	warmupRequestTimeout         = 30 * time.Second
	warmupStreamMaxBytes         = 256 << 10
	warmupAccountGap             = 2 * time.Second
	planCatalogRefreshInterval   = 15 * time.Minute
	planCatalogMaxAge            = 30 * time.Minute
	maxPlanCatalogModels         = 2048
)

// systemZone 与控制面 src/shared/system-time.mjs 一致：固定 UTC+8。
var systemZone = time.FixedZone("UTC+8", 8*3600)

// WarmupPolicy 由控制面 Codex 设置 warmup 经心跳下发；Times 为本地 "HH:MM"。
type WarmupPolicy struct {
	Enabled bool     `json:"enabled"`
	Times   []string `json:"times"`
	Model   string   `json:"model"`
}

// runtimePolicy 保存心跳响应下发的后台策略（持久化，重启后沿用）。
type runtimePolicy struct {
	mu         sync.Mutex
	path       string
	Warmup     *WarmupPolicy `json:"warmup,omitempty"`
	LastWarmup string        `json:"last_warmup_slot,omitempty"`
	// ResetCredit 是自动使用重置卡的策略（只交给一个在线实例执行）
	ResetCredit *ResetCreditPolicy `json:"reset_credit,omitempty"`
}

func loadRuntimePolicy(path string) *runtimePolicy {
	out := &runtimePolicy{path: path}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, out)
	}
	return out
}

func (p *runtimePolicy) saveLocked() {
	if p.path == "" {
		return
	}
	if data, err := json.Marshal(p); err == nil {
		_ = writeFileAtomic(p.path, data)
	}
}

func (p *runtimePolicy) setWarmup(policy *WarmupPolicy) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Warmup = policy
	p.saveLocked()
}

func (p *runtimePolicy) setResetCredit(policy *ResetCreditPolicy) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ResetCredit = policy
	p.saveLocked()
}

func (p *runtimePolicy) resetCreditPolicy() *ResetCreditPolicy {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ResetCredit == nil {
		return nil
	}
	policy := *p.ResetCredit
	return &policy
}

// claimWarmup 返回本分钟应执行的预热模型；同一时段只执行一次。
func (p *runtimePolicy) claimWarmup(now time.Time) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	policy := p.Warmup
	if policy == nil || !policy.Enabled || strings.TrimSpace(policy.Model) == "" {
		return "", false
	}
	local := now.In(systemZone)
	clock := local.Format("15:04")
	matched := false
	for _, at := range policy.Times {
		if strings.TrimSpace(at) == clock {
			matched = true
			break
		}
	}
	slot := local.Format("2006-01-02T15:04")
	if !matched || p.LastWarmup == slot {
		return "", false
	}
	p.LastWarmup = slot
	p.saveLocked()
	return strings.TrimSpace(policy.Model), true
}

// applyHeartbeatPolicy 采用心跳响应中的策略；缺失字段保持原状。
func (s *Server) applyHeartbeatPolicy(body []byte) {
	var response struct {
		Policy *struct {
			AccountProtection *ProtectionPolicy       `json:"account_protection"`
			Warmup            *WarmupPolicy           `json:"warmup"`
			ResetCredit       *ResetCreditPolicy      `json:"reset_credit"`
			CreditOverage     *bool                   `json:"credit_overage"`
			ClientProfile     *ClientProfileSelection `json:"client_profile"`
			ProfileDeployment ProfileDeployment       `json:"profile_deployment"`
			Privacy           *PrivacyPolicy          `json:"privacy"`
			// ExecutorEvents：控制面是否消费事件发件箱（KIN_EXECUTOR_EVENTS 为 shadow/primary）；旧版控制面不下发，视为不消费
			ExecutorEvents *struct {
				Required bool `json:"required"`
			} `json:"executor_events"`
			// RefreshLease：刷新原生或 BPS 授权前先向控制面申请租约（KIN_REFRESH_LEASE=on）；旧版控制面不下发，视为不需要
			// SettingsRevision：这份策略所属的控制面 Codex 设置版本（P4.3）；Worker 记录已应用的版本，在健康接口与心跳中报告
			SettingsRevision *int64 `json:"settings_revision"`
			RefreshLease     *struct {
				Required bool `json:"required"`
				// Designated：指派给本实例做定时预刷新的运行账号（P3.3）；未下发时不限制
				Designated *[]string `json:"designated"`
			} `json:"refresh_lease"`
			AccountFreezes *[]struct {
				AccountID      string    `json:"account_id"`
				FrozenUntil    time.Time `json:"frozen_until"`
				Reason         string    `json:"reason"`
				SourceInstance string    `json:"source_instance"`
			} `json:"account_freezes"`
		} `json:"policy"`
	}
	if json.Unmarshal(body, &response) != nil || response.Policy == nil {
		return
	}
	s.events.setRequired(response.Policy.ExecutorEvents != nil && response.Policy.ExecutorEvents.Required)
	s.refreshLease.Store(response.Policy.RefreshLease != nil && response.Policy.RefreshLease.Required)
	if response.Policy.SettingsRevision != nil {
		s.settingsRevision.Store(*response.Policy.SettingsRevision)
	}
	var designated map[string]bool
	if lease := response.Policy.RefreshLease; lease != nil && lease.Required && lease.Designated != nil {
		designated = make(map[string]bool, len(*lease.Designated))
		for _, id := range *lease.Designated {
			designated[id] = true
		}
	}
	s.refreshDesignated.Store(&designated)
	if response.Policy.AccountProtection != nil {
		s.protection.observe(response.Policy.AccountProtection)
	}
	s.runtime.setWarmup(response.Policy.Warmup)
	s.runtime.setResetCredit(response.Policy.ResetCredit)
	if response.Policy.CreditOverage != nil {
		s.store.SetCreditOverage(*response.Policy.CreditOverage)
	}
	if selection := response.Policy.ClientProfile; selection == nil || selection.validate() == nil {
		s.profilePolicy.set(selection, response.Policy.ProfileDeployment)
	}
	if response.Policy.Privacy != nil {
		s.privacy.observe(response.Policy.Privacy)
	}
	if response.Policy.AccountFreezes != nil {
		freezes := map[string]PeerFreeze{}
		for _, item := range *response.Policy.AccountFreezes {
			if item.AccountID != "" && item.SourceInstance != s.cfg.InstanceID {
				freezes[item.AccountID] = PeerFreeze{Until: item.FrozenUntil.UTC(), Source: item.SourceInstance, Reason: item.Reason}
			}
		}
		s.store.ApplyPeerFreezes(freezes)
	}
}

type quotaRefreshAttempt struct{ at time.Time }

type quotaScheduler struct {
	mu          sync.Mutex
	lastRefresh map[string]quotaRefreshAttempt
	initialDue  map[string]time.Time
}

func newQuotaScheduler() *quotaScheduler {
	return &quotaScheduler{lastRefresh: map[string]quotaRefreshAttempt{}, initialDue: map[string]time.Time{}}
}

func accessTokenCurrent(account Account, now time.Time) bool {
	return account.ExpiresAt.IsZero() || account.ExpiresAt.After(now)
}

func eligibleQuotaRefresh(account Account, now time.Time) bool {
	return account.APIKey == "" && account.Enabled && !account.Paused && accessTokenCurrent(account, now) && account.AccessToken != ""
}

// quotaExhaustedState：任一窗口已满或处于额度冷却即视为耗尽；返回最近的重置时刻（可能已过去）。
func quotaExhaustedState(account Account) (bool, time.Time) {
	var reset time.Time
	exhausted := false
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, _ := account.Quota[key].(map[string]any)
		used, _ := window["used_percent"].(float64)
		if used < 100 {
			continue
		}
		exhausted = true
		if at, err := time.Parse(time.RFC3339Nano, fmt.Sprint(window["reset_at"])); err == nil && (reset.IsZero() || at.Before(reset)) {
			reset = at
		}
	}
	if account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted) {
		exhausted = true
		if reset.IsZero() {
			reset = account.CooldownUntil
		}
	}
	return exhausted, reset
}

// expiredUsedWindowReset：有用量的窗口越过 reset+2min 时返回最早的重置时刻。
func expiredUsedWindowReset(quota map[string]any, now time.Time) (time.Time, bool) {
	var earliest time.Time
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, _ := quota[key].(map[string]any)
		used, _ := window["used_percent"].(float64)
		if used <= 0 {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, fmt.Sprint(window["reset_at"]))
		if err != nil || at.Add(quotaResetGrace).After(now) {
			continue
		}
		if earliest.IsZero() || at.Before(earliest) {
			earliest = at
		}
	}
	return earliest, !earliest.IsZero()
}

func quotaObserved(account Account) bool {
	updated, _ := account.Quota["updated_at"].(string)
	return updated != ""
}

// reservePeriodic 返回本轮应复核的账号并记下复核时刻。
func (q *quotaScheduler) reservePeriodic(accounts []Account, now time.Time) []Account {
	q.mu.Lock()
	defer q.mu.Unlock()
	candidates := map[string]bool{}
	var reserved []Account
	for _, account := range accounts {
		if !eligibleQuotaRefresh(account, now) {
			continue
		}
		exhausted, reset := quotaExhaustedState(account)
		var dueAt time.Time
		interval := periodicQuotaRefreshInterval
		if exhausted {
			if !reset.IsZero() && now.After(reset) {
				since := now.Sub(reset)
				// 上游边界附近可能仍返回旧额度，首次复核保留传播余量
				if since < exhaustedQuotaResetGrace {
					candidates[account.ID] = true
					continue
				}
				interval = quotaResetRetryInterval
				if since < quotaResetFastWindow {
					interval = quotaResetFastInterval
				}
			}
			if !reset.IsZero() {
				dueAt = reset.Add(exhaustedQuotaResetGrace)
			}
		} else {
			at, ok := expiredUsedWindowReset(account.Quota, now)
			if !ok {
				continue
			}
			dueAt = at.Add(quotaResetGrace)
		}
		candidates[account.ID] = true
		last, seen := q.lastRefresh[account.ID]
		if seen && now.Sub(last.at) < interval && !(!dueAt.IsZero() && last.at.Before(dueAt) && !dueAt.After(now)) {
			continue
		}
		q.lastRefresh[account.ID] = quotaRefreshAttempt{at: now}
		reserved = append(reserved, account)
	}
	for id := range q.lastRefresh {
		if !candidates[id] {
			delete(q.lastRefresh, id)
		}
	}
	return reserved
}

// reserveInitial 为尚无额度快照的账号分配随机首查时点，返回已到期的候选（每轮最多 100 个）。
func (q *quotaScheduler) reserveInitial(accounts []Account, now time.Time) []Account {
	q.mu.Lock()
	defer q.mu.Unlock()
	candidates := map[string]bool{}
	var due []Account
	for _, account := range accounts {
		if quotaObserved(account) || account.CredentialState != "" || !eligibleQuotaRefresh(account, now) {
			continue
		}
		candidates[account.ID] = true
		at, ok := q.initialDue[account.ID]
		if !ok {
			at = now.Add(time.Duration(rand.Int64N(int64(initialQuotaSyncMaxDelay))))
			q.initialDue[account.ID] = at
		}
		if !at.After(now) && len(due) < initialQuotaSyncBatch {
			due = append(due, account)
		}
	}
	for id := range q.initialDue {
		if !candidates[id] {
			delete(q.initialDue, id)
		}
	}
	return due
}

// deferInitial：首查失败的账号重新抽取随机延迟，避免固定节奏重试同一批。
func (q *quotaScheduler) deferInitial(id string, now time.Time) {
	q.mu.Lock()
	q.initialDue[id] = now.Add(time.Duration(rand.Int64N(int64(initialQuotaSyncMaxDelay))))
	q.mu.Unlock()
}

func (s *Server) backgroundLoop(ctx context.Context) {
	go s.releaseLoop(ctx)
	ticker := time.NewTicker(backgroundTick)
	defer ticker.Stop()
	nextCatalog := time.Now().Add(backgroundTick)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.refreshQuotas(ctx, now)
			if !now.Before(nextCatalog) {
				s.refreshPlanCatalogs(ctx, now)
				nextCatalog = now.Add(planCatalogRefreshInterval)
			}
			if model, ok := s.runtime.claimWarmup(now); ok {
				go s.runWarmup(ctx, model)
			}
		}
	}
}

func (s *Server) refreshQuotas(ctx context.Context, now time.Time) {
	accounts := s.store.snapshot()
	for _, account := range s.quotas.reserveInitial(accounts, now) {
		if ctx.Err() != nil {
			return
		}
		if _, _, err := s.backgroundQuery(ctx, account.ID); err != nil {
			s.quotas.deferInitial(account.ID, time.Now())
		}
	}
	for _, account := range s.quotas.reservePeriodic(accounts, now) {
		if ctx.Err() != nil {
			return
		}
		_, _, _ = s.backgroundQuery(ctx, account.ID)
	}
}

// backgroundQuery 查询 /wham/usage；上游 5xx 有界重试 2 次（1s、2s）。
func (s *Server) backgroundQuery(ctx context.Context, id string) (map[string]any, int, error) {
	var lastErr error
	for attempt := 0; attempt <= quotaFetch5xxRetries; attempt++ {
		if attempt > 0 && !sleepContext(ctx, time.Duration(attempt)*time.Second) {
			return nil, 0, ctx.Err()
		}
		callCtx, cancel := context.WithTimeout(ctx, accountRequestTimeout)
		result, status, err := s.queryQuota(callCtx, id)
		cancel()
		if err == nil || status < 500 || status == http.StatusBadGateway && ctx.Err() != nil {
			return result, status, err
		}
		lastErr = err
	}
	return nil, http.StatusBadGateway, lastErr
}

// runWarmup 对 OAuth 账号逐个发送最小请求；周窗口已满或 5h 窗口仍有 30 分钟以上活跃期的账号跳过。
func (s *Server) runWarmup(ctx context.Context, model string) {
	if !s.warmupRunning.CompareAndSwap(false, true) {
		return
	}
	defer s.warmupRunning.Store(false)
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return
		}
		now := time.Now()
		if account.APIKey != "" || !account.Enabled || account.Paused || account.CredentialState != "" || !credentialUsable(account, now) {
			continue
		}
		if warmupSkip(account.Quota, now) {
			continue
		}
		body, _ := json.Marshal(map[string]any{
			"model":        model,
			"input":        []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hello"}}}},
			"stream":       true,
			"store":        false,
			"service_tier": "default",
			"reasoning":    map[string]any{"effort": "low"},
			"text":         map[string]any{"verbosity": "low"},
		})
		callCtx, cancel := context.WithTimeout(ctx, warmupRequestTimeout)
		header, rateLimits, err := s.auxiliaryResponse(callCtx, account, body, warmupStreamMaxBytes)
		cancel()
		if err == nil {
			// 只有完成的预热才同步被动额度，失败流不能把窗口标为可用
			if evidence := parseQuotaHeaders(header, time.Now()); evidence.Confidence != "unknown" {
				s.store.UpdateQuota(account.ID, quotaMap(evidence))
			}
			for _, limits := range rateLimits {
				s.store.MergeQuota(account.ID, limits)
			}
		}
		if !sleepContext(ctx, warmupAccountGap) {
			return
		}
	}
}

// warmupSkip：周窗口已触顶，或 5h 窗口距重置仍超过 30 分钟（已在计时）。
func warmupSkip(quota map[string]any, now time.Time) bool {
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, _ := quota[key].(map[string]any)
		minutes, _ := window["window_minutes"].(float64)
		used, _ := window["used_percent"].(float64)
		reset, err := time.Parse(time.RFC3339Nano, fmt.Sprint(window["reset_at"]))
		switch {
		case minutes >= 6*24*60 && used >= 100:
			return true
		case minutes > 0 && minutes <= 360 && err == nil && reset.After(now.Add(30*time.Minute)):
			return true
		}
	}
	return false
}

var errAuxiliaryIncomplete = errors.New("response did not complete")

// auxiliaryResponse 发送一次不计入保护证据的最小 Responses 请求，读到终态为止；
// 返回响应头与流内 codex.rate_limits 观测。供预热与冻结探测共用。
func (s *Server) auxiliaryResponse(ctx context.Context, account Account, body []byte, maxBytes int) (http.Header, []map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.UpstreamBaseURL, "/")+"/responses", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("x-codex-routing-hint", codexRoutingHint(body))
	applyProfileIdentity(req.Header, account, s.globalProfile())
	client, err := s.clientFor(account)
	if err != nil {
		return nil, nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		failure := classifyHTTPFailure(resp.StatusCode, resp.Header, data, time.Now())
		return resp.Header, nil, fmt.Errorf("HTTP %d %s", resp.StatusCode, failure.Category)
	}
	var rateLimits []map[string]any
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, int64(maxBytes)))
	scanner.Buffer(make([]byte, 64<<10), maxBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event) != nil {
			continue
		}
		kind, _ := event["type"].(string)
		switch kind {
		case "codex.rate_limits":
			if limits := parseRateLimitsEvent(event, time.Now()); len(limits) > 0 {
				rateLimits = append(rateLimits, limits)
			}
		case "response.completed", "response.done":
			response, _ := event["response"].(map[string]any)
			if status, ok := response["status"].(string); ok && status != "completed" {
				return resp.Header, nil, fmt.Errorf("response status %s", status)
			}
			return resp.Header, rateLimits, nil
		case "response.failed", "response.incomplete", "error":
			return resp.Header, nil, fmt.Errorf("response ended with %s", kind)
		}
	}
	return resp.Header, nil, errAuxiliaryIncomplete
}

// planCatalog 是某套餐的上游模型目录（slug → 是否支持 priority 档位）。
type planCatalog struct {
	observedAt time.Time
	models     map[string]bool
}

type planCatalogs struct {
	mu      sync.RWMutex
	entries map[string]planCatalog
}

func planScope(account Account) string {
	plan := strings.ToLower(strings.TrimSpace(account.Plan))
	if plan == "" {
		return "unknown"
	}
	return plan
}

func parsePlanCatalog(data []byte) map[string]bool {
	var parsed struct {
		Models []struct {
			Slug         string `json:"slug"`
			ServiceTiers []struct {
				ID string `json:"id"`
			} `json:"service_tiers"`
		} `json:"models"`
	}
	if json.Unmarshal(data, &parsed) != nil || len(parsed.Models) == 0 || len(parsed.Models) > maxPlanCatalogModels {
		return nil
	}
	out := make(map[string]bool, len(parsed.Models))
	for _, model := range parsed.Models {
		if model.Slug == "" {
			return nil
		}
		priority := false
		for _, tier := range model.ServiceTiers {
			priority = priority || tier.ID == "priority"
		}
		out[model.Slug] = priority
	}
	return out
}

// refreshPlanCatalogs 每个已知套餐最多尝试 3 个账号读取目录；未知套餐不建立目录。
func (s *Server) refreshPlanCatalogs(ctx context.Context, now time.Time) {
	byPlan := map[string][]Account{}
	for _, account := range s.store.snapshot() {
		if account.APIKey != "" || !account.Enabled || account.Paused || !credentialUsable(account, now) || planScope(account) == "unknown" {
			continue
		}
		byPlan[planScope(account)] = append(byPlan[planScope(account)], account)
	}
	for plan, accounts := range byPlan {
		for i, account := range accounts {
			if i >= 3 || ctx.Err() != nil {
				break
			}
			data, err := s.fetchCatalogWith(ctx, account, s.globalProfile().CodexVersion)
			if err != nil {
				continue
			}
			if models := parsePlanCatalog(data); models != nil {
				s.plans.mu.Lock()
				s.plans.entries[plan] = planCatalog{observedAt: time.Now(), models: models}
				s.plans.mu.Unlock()
				break
			}
		}
	}
}

// lookup 返回套餐目录对模型的结论：known=false 表示没有可用目录（交由上游判断）。
func (p *planCatalogs) lookup(account Account, model string, now time.Time) (contains, priority, known bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	catalog, ok := p.entries[planScope(account)]
	if !ok || now.Sub(catalog.observedAt) >= planCatalogMaxAge {
		return false, false, false
	}
	priority, contains = catalog.models[model]
	return contains, priority, true
}

// accountEligible 对齐 CPR CodexSelectionModel::allows_account 与套餐目录排除：
// OAuth 账号不承接 grok；生图与 Live 排除明确的 Free 套餐；未声明模型的生图/搜索只选不限模型的账号；
// 新鲜的套餐目录不含该模型时排除。
func (s *Server) accountEligible(account Account, operation, model string, now time.Time) bool {
	if account.APIKey != "" {
		return operation != "live"
	}
	base := model
	if index := strings.LastIndex(base, "/"); index >= 0 {
		base = base[index+1:]
	}
	if strings.EqualFold(base, "grok") || (len(base) >= 5 && strings.EqualFold(base[:5], "grok-")) {
		return false
	}
	image := strings.HasPrefix(operation, "images")
	if (image || operation == "live") && strings.EqualFold(strings.TrimSpace(account.Plan), "free") {
		return false
	}
	if model == "" {
		return !(image || operation == "search") || (len(account.Models) == 0 && len(account.DeniedModels) == 0)
	}
	if operation == "responses" || operation == "chat" || operation == "live" {
		if contains, _, known := s.plans.lookup(account, model, now); known && !contains {
			return false
		}
	}
	return true
}

// applyFastPolicy 对齐 CPR apply_fast_policy：disabled 把 priority/fast 改回 default；enabled 在目录声明
// 支持 priority 时把未指定或 default 的档位改为 priority；其他显式档位保留客户端选择。
func applyFastPolicy(body []byte, mode string, supportsPriority bool) []byte {
	var fields struct {
		ServiceTier *json.RawMessage `json:"service_tier"`
	}
	if json.Unmarshal(topLevelSubset(body, "service_tier"), &fields) != nil {
		return body
	}
	tier := ""
	isNull := fields.ServiceTier == nil || strings.TrimSpace(string(*fields.ServiceTier)) == "null"
	if !isNull {
		_ = json.Unmarshal(*fields.ServiceTier, &tier)
		tier = strings.TrimSpace(tier)
	}
	target := ""
	switch {
	case mode == "disabled" && (strings.EqualFold(tier, "priority") || strings.EqualFold(tier, "fast")):
		target = "default"
	case mode == "enabled" && supportsPriority && (isNull || strings.EqualFold(tier, "default")):
		target = "priority"
	default:
		return body
	}
	value, _ := json.Marshal(target)
	present := false
	out, _, err := rewriteObject(body, func(key string, v json.RawMessage) (json.RawMessage, bool, bool) {
		if key == "service_tier" {
			present = true
			return value, false, true
		}
		return v, false, false
	})
	if err != nil {
		return body
	}
	if !present {
		out = appendObjectField(out, "service_tier", value)
	}
	return out
}

func serviceTierOf(body []byte) string {
	var fields struct {
		ServiceTier string `json:"service_tier"`
	}
	_ = json.Unmarshal(topLevelSubset(body, "service_tier"), &fields)
	return strings.TrimSpace(fields.ServiceTier)
}

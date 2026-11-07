package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// 调度对齐 codex-proxy-rs：smart 评分（负载/额度/健康/延迟/重置）、权重分层、三种会话亲和、
// 按账号 FIFO 的有界并发等待与 Guardian 独立并发池。

const (
	healthEWMAAlpha          = 0.2
	capacityFailureEWMAAlpha = 0.4
	failureRateHalfLife      = 15 * time.Minute
	smartLatencyHalfScoreMS  = 10_000.0
	smartResetHalfScoreSec   = 3_600.0
	defaultWaitTimeout       = 30 * time.Second
	maxWaitTimeout           = 120 * time.Second
	waitRecheckInterval      = 250 * time.Millisecond
	defaultSessionTTL        = 24 * time.Hour
	maxSessionBindings       = 200_000
	defaultGuardianLimit     = 5
	defaultMaxWaitingPerAcct = 10
	maxWaitersPerWorker      = 1024
)

var (
	// ErrQueueFull：本地等待队列已满（CPR concurrency_queue_full），不是上游限流。
	ErrQueueFull = errors.New("concurrency wait queue is full")
	// ErrQueueTimeout：等待超过请求级等待预算（CPR concurrency_queue_timeout）。
	ErrQueueTimeout = errors.New("concurrency wait timed out")
	// ErrContinuationOwnerChanged：严格亲和下会话已迁到其他账号，旧账号的续接不能把会话拉回（CPR）。
	ErrContinuationOwnerChanged = errors.New("session moved to another account; replay the full input")
	// ErrAccountCapacityUnavailable：账号满载且关闭了账号排队（CPR account_capacity_unavailable，503）。
	ErrAccountCapacityUnavailable = errors.New("all eligible accounts are at capacity and waiting is disabled")
	// ErrSessionPolicyRestricted：本会话的全部候选账号都因 cyber_policy 被排除。
	ErrSessionPolicyRestricted = errors.New("no account is available for this session after an upstream cyber policy rejection")
	errBlocked                 = errors.New("capacity blocked")
)

// followOnlyMaxWaiting / followOnlyWaitTimeout：关闭普通排队时后代线程仍按有界人数与时长等待根线程账号（CPR）。
const (
	followOnlyMaxWaiting  = 1000
	followOnlyWaitTimeout = 30 * time.Second
)

// SchedulingPolicy 由控制面按 Codex 设置 scheduling 下发，每个请求冻结一份。
type SchedulingPolicy struct {
	Strategy      string             `json:"strategy,omitempty"`
	Affinity      string             `json:"affinity,omitempty"`
	SmartWeights  map[string]float64 `json:"smart_weights,omitempty"`
	WaitTimeoutMS int                `json:"wait_timeout_ms,omitempty"`
	// BPSEnabled 是全局 BPS 总开关（控制面 Codex 设置 bps_enabled）：关闭时所有请求只走原生通道
	BPSEnabled bool `json:"bps_enabled,omitempty"`
	// BPSImages 是 BPS 图片策略（控制面 Codex 设置 bps_images），缺省按 auto_compact / 20 张 / 32 MiB / 64 MiB
	BPSImages *BPSImageSettings `json:"bps_images,omitempty"`
	// RoutePolicy 是 Key 级通道策略（api_keys.codex_route）：native_only 只走原生，bps_only 只走 BPS（无可用 BPS 时失败）
	RoutePolicy string `json:"route_policy,omitempty"`
	// SettingsRevision 是这些设置所属的控制面 Codex 设置版本（同一快照），写进回执供诊断
	SettingsRevision int64 `json:"settings_revision,omitempty"`
}

var defaultSmartWeights = map[string]float64{"load": 1, "quota": 0.8, "health": 1, "latency": 0.5, "reset": 0}

func (p SchedulingPolicy) strategy() string {
	switch p.Strategy {
	case "smart", "quota_reset_priority", "round_robin", "sticky":
		return p.Strategy
	}
	return "smart"
}

func (p SchedulingPolicy) affinity() string {
	switch p.Affinity {
	case "strict", "preferred", "relaxed":
		return p.Affinity
	}
	return "preferred"
}

func (p SchedulingPolicy) weight(name string) float64 {
	if value, ok := p.SmartWeights[name]; ok && value >= 0 {
		return value
	}
	if len(p.SmartWeights) > 0 {
		return 0
	}
	return defaultSmartWeights[name]
}

// scoreTolerance 与系数总和同步缩放，避免同比放大系数改变近似最优候选集合。
func (p SchedulingPolicy) scoreTolerance() float64 {
	sum := 0.0
	for _, name := range []string{"load", "quota", "health", "latency", "reset"} {
		sum += math.Round(p.weight(name) * 10)
	}
	return 0.05 * sum / 33.0
}

func (p SchedulingPolicy) waitTimeout() time.Duration {
	if p.WaitTimeoutMS <= 0 {
		return defaultWaitTimeout
	}
	return min(time.Duration(p.WaitTimeoutMS)*time.Millisecond, maxWaitTimeout)
}

type selectRequest struct {
	Scope     Scope
	Model     string
	Operation string
	Exclude   map[string]bool
	Guardian  bool
	Policy    SchedulingPolicy
	// ClientScope 隔离不同调用方的会话绑定（CPR 亲和键含客户端 API Key）
	ClientScope string
	// FollowOnly：能识别出的后代线程或子代理；严格亲和下已有绑定时只跟随该账号，不换号也不改写绑定
	FollowOnly bool
	// Continuation：钉住的是原生续接（previous_response_id）的原账号
	Continuation bool
	// SessionExclude 是本会话因 cyber_policy 拒绝而排除的账号
	SessionExclude map[string]bool
	// BPS 为 true 时按 BPS 通道选号（账号的 BPS 名单、授权与状态，见 bpsUsable）；BPSRequest 是请求的可承载性
	BPS        bool
	BPSRequest bpsRequest
	// NoWait：没有就绪账号时不排队，直接返回 ErrNoEligibleAccount（BPS 阶段满载即改走原生）
	NoWait bool
	// HistoryOwner 是请求历史里最新原生密文的签发账号（route_provenance.go）：就绪时优先于会话主账号与权重，
	// 只是暂时满载时排队等它；冷却、停用、已在本请求失败或不在范围内时正常选号（换号后由密文被拒恢复兜底）
	HistoryOwner string
	// CachePreference 是无会话请求的内容亲和键（cache_preference.go）：只参与选号绑定，不是会话、轮次或传输身份
	CachePreference string
}

// sessionKey 是会话绑定键；没有会话 ID 时用内容亲和键（CPR e3904178：无会话请求按缓存键或开头消息偏向同一账号）。
func (r selectRequest) sessionKey() string {
	if r.Scope.SessionID != "" {
		return r.ClientScope + "\x00" + r.Scope.SessionID
	}
	if r.CachePreference != "" {
		return r.ClientScope + "\x00" + r.CachePreference
	}
	return ""
}

func (r selectRequest) followsSession() bool {
	return r.FollowOnly && r.Policy.affinity() == "strict"
}

type sessionBinding struct {
	account string
	expires time.Time
}

// accountFeedback 是已发送尝试的账号级平滑失败率（随时间半衰）与首个有效输出延迟。
type accountFeedback struct {
	failureRate   float64
	updatedAt     time.Time
	firstOutputMS float64
}

func (f *accountFeedback) failureAt(now time.Time) float64 {
	if f.updatedAt.IsZero() {
		return f.failureRate
	}
	elapsed := now.Sub(f.updatedAt)
	if elapsed < 0 {
		elapsed = 0
	}
	return f.failureRate * math.Pow(0.5, elapsed.Seconds()/failureRateHalfLife.Seconds())
}

type feedbackKind int

const (
	feedbackSucceeded feedbackKind = iota
	feedbackFailed
	feedbackCapacityRejected
)

type waitTicket struct {
	account  string
	guardian bool
	wake     chan struct{}
}

type queueKey struct {
	account  string
	guardian bool
}

type scheduler struct {
	mu                   sync.Mutex
	feedback             map[string]*accountFeedback
	bindings             map[string]sessionBinding
	queues               map[queueKey][]*waitTicket
	waiting              int
	cursor               uint64
	guardianLimit        int
	maxWaitingPerAccount int
	sessionTTL           time.Duration
}

func newScheduler() *scheduler {
	return &scheduler{feedback: map[string]*accountFeedback{}, bindings: map[string]sessionBinding{}, queues: map[queueKey][]*waitTicket{}, guardianLimit: defaultGuardianLimit, maxWaitingPerAccount: defaultMaxWaitingPerAcct, sessionTTL: defaultSessionTTL}
}

// RecordFeedback 只接受已发送的尝试：成功、可计分失败或明确容量拒绝。
func (s *Store) RecordFeedback(id string, kind feedbackKind, firstOutput time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	feedback := s.sched.feedback[id]
	if feedback == nil {
		feedback = &accountFeedback{}
		s.sched.feedback[id] = feedback
	}
	now := time.Now()
	sample, alpha := 0.0, healthEWMAAlpha
	switch kind {
	case feedbackFailed:
		sample = 1
	case feedbackCapacityRejected:
		sample, alpha = 1, capacityFailureEWMAAlpha
	}
	feedback.failureRate = alpha*sample + (1-alpha)*feedback.failureAt(now)
	feedback.updatedAt = now
	if ms := float64(firstOutput.Milliseconds()); ms > 0 {
		if feedback.firstOutputMS == 0 {
			feedback.firstOutputMS = ms
		} else {
			feedback.firstOutputMS = healthEWMAAlpha*ms + (1-healthEWMAAlpha)*feedback.firstOutputMS
		}
	}
}

// poolFailureMedian 是近期（一个半衰期内）有反馈账号的衰减失败率中位数；不足 3 个账号时 ok=false。
func (s *Store) poolFailureMedian(exclude string, now time.Time) (float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	values := []float64{}
	for id, feedback := range s.sched.feedback {
		if id == exclude || feedback.updatedAt.IsZero() || now.Sub(feedback.updatedAt) > failureRateHalfLife {
			continue
		}
		values = append(values, min(1, max(0, feedback.failureAt(now))))
	}
	if len(values) < poolSignalMinAccounts {
		return 0, false
	}
	sort.Float64s(values)
	mid := len(values) / 2
	if len(values)%2 == 1 {
		return values[mid], true
	}
	return (values[mid-1] + values[mid]) / 2, true
}

// poolOverloaded：近期活跃账号一起失败，说明上游在整体限流，继续换号只会加压。
func (s *Store) poolOverloaded(now time.Time) bool {
	median, ok := s.poolFailureMedian("", now)
	return ok && median >= poolOverloadFailure
}

// parkOverloadOutlier 在账号失败率远高于其余账号时停放 overloadOutlierHold；全池同时过载时不停放，
// 否则高峰期会把整个池清空。返回是否停放。
func (s *Store) parkOverloadOutlier(id string, now time.Time) bool {
	s.mu.RLock()
	feedback := s.sched.feedback[id]
	own := 0.0
	if feedback != nil {
		own = feedback.failureAt(now)
	}
	s.mu.RUnlock()
	if own < overloadOutlierFailure {
		return false
	}
	peers, ok := s.poolFailureMedian(id, now)
	if !ok || own-peers < overloadOutlierGap {
		return false
	}
	s.mu.Lock()
	account, exists := s.accounts[id]
	if !exists || !now.Add(overloadOutlierHold).After(account.CooldownUntil) {
		s.mu.Unlock()
		return false
	}
	account.CooldownUntil = now.Add(overloadOutlierHold)
	account.CooldownReason = "overload_outlier"
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	s.persistSoon()
	return true
}

// feedbackForFailure 与 CPR 的 OPENAI_ACCOUNT_SCORE_FAILURE_REASONS 闭集一致：
// 只有容量、限流和服务端错误计入健康分；凭据、请求和额度问题有独立处置。
// feedbackForFailure 对齐 CPR OPENAI_ACCOUNT_SCORE_FAILURE_REASONS：只有上游 code（缺失时取 type）属于闭集的失败计入
// 健康分，容量拒绝单独计为容量反馈；裸状态码（如无 code 的 429）不计。
func feedbackForFailure(failure upstreamFailure) (feedbackKind, bool) {
	if failure.Category == categoryCapacity {
		// 容量拒绝（server_is_overloaded / slow_down，均在闭集内）按容量反馈计
		return feedbackCapacityRejected, true
	}
	reason := strings.ToLower(strings.TrimSpace(failure.Code))
	if reason == "" {
		reason = strings.ToLower(strings.TrimSpace(failure.Type))
	}
	switch reason {
	case "rate_limit_exceeded", "rate_limit_error", "server_error", "service_unavailable_error":
		return feedbackFailed, true
	}
	return 0, false
}

func (s *Store) inFlight(account Account, guardian bool) (int, int) {
	if guardian && s.sched.guardianLimit > 0 {
		return account.GuardianInFlight, s.sched.guardianLimit
	}
	return account.InFlight, account.MaxConcurrency
}

type candidateSet struct {
	ready     []Account
	blocked   []Account
	inScope   int
	exhausted int
	// sessionExcluded 是因 cyber_policy 会话排除而跳过的账号数
	sessionExcluded int
}

// collect 在持锁状态下按资格分出可立即使用与仅因并发/等待顺序受阻的账号。
func (s *Store) collect(req selectRequest, now time.Time, ticket *waitTicket) candidateSet {
	var set candidateSet
	ids := map[string]bool{}
	for _, id := range req.Scope.ScopeIDs {
		ids[id] = true
	}
	for _, group := range req.Scope.GroupIDs {
		ids[fmt.Sprint(group)] = true
	}
	for _, account := range s.accounts {
		if len(ids) > 0 && !intersects(account.Groups, ids) {
			continue
		}
		if len(account.Models) > 0 && !contains(account.Models, req.Model) {
			continue
		}
		if contains(account.DeniedModels, req.Model) {
			continue
		}
		if req.Scope.RuntimeAccountID != "" && account.ID != req.Scope.RuntimeAccountID {
			continue
		}
		if req.Scope.CredentialRevision > 0 && account.CredentialRevision != req.Scope.CredentialRevision {
			continue
		}
		if !account.Enabled || account.Paused {
			continue
		}
		// BPS 通道只看账号的 BPS 授权与状态；原生凭据、错误保护与原生冷却只约束原生通道
		if req.BPS {
			if !bpsUsable(account, req.Model, req.BPSRequest, now) {
				continue
			}
		} else {
			if !credentialUsable(account, now) || protectionFrozen(account, now) {
				continue
			}
			if s.eligible != nil && !s.eligible(account, req.Operation, req.Model, now) {
				continue
			}
		}
		set.inScope++
		if req.SessionExclude[account.ID] {
			set.sessionExcluded++
			continue
		}
		// 额度耗尽是访问结论（CPR QuotaState）：只由证据解除，冷却到期只表示该复查，不放行；
		// 窗口百分比只用于展示与排序，不单独判定耗尽
		if quotaExhaustedFact(account) {
			set.exhausted++
			continue
		}
		if req.Exclude[account.ID] {
			continue
		}
		if !req.BPS && account.CooldownUntil.After(now) {
			continue
		}
		if until, ok := account.ModelCooldowns[req.Model]; !req.BPS && ok && until.After(now) {
			continue
		}
		// 账号 RPM 是准入上限，不排队等待分钟窗口滚动
		if account.MaxRPM > 0 && len(s.rpm[account.ID]) >= account.MaxRPM {
			continue
		}
		if quotaUnavailable(account.Quota, now) {
			continue
		}
		used, limit := s.inFlight(account, req.Guardian)
		pool := queueKey{account.ID, req.Guardian && s.sched.guardianLimit > 0}
		queue := s.sched.queues[pool]
		// 新请求不能越过同池等待者；只有该账号队首可以取得空位
		reserved := len(queue) > 0 && (ticket == nil || queue[0] != ticket)
		if (limit > 0 && used >= limit) || reserved {
			set.blocked = append(set.blocked, account)
			continue
		}
		set.ready = append(set.ready, account)
	}
	return set
}

// trySelect 返回取得租约的账号；受阻时返回 errBlocked 与应排队的账号。
func (s *Store) trySelect(req selectRequest, now time.Time, ticket *waitTicket) (Account, string, error) {
	s.pruneRPM(now)
	sessionKey := req.sessionKey()
	affinity := req.Policy.affinity()
	var bound string
	if sessionKey != "" && affinity != "relaxed" {
		if binding, ok := s.sched.bindings[sessionKey]; ok && binding.expires.After(now) {
			bound = binding.account
		}
	}
	// 严格亲和：会话已迁到其他账号时，旧账号的续接不能把会话拉回，交回客户端带完整历史重放
	if affinity == "strict" && req.Continuation && bound != "" && req.Scope.RuntimeAccountID != "" && bound != req.Scope.RuntimeAccountID {
		return Account{}, "", ErrContinuationOwnerChanged
	}
	followOnly := req.followsSession() && bound != ""
	if followOnly && req.Exclude[bound] {
		// 根线程账号已在本请求中失败：后代线程不换号，按原错误交付
		return Account{}, "", ErrNoEligibleAccount
	}
	set := s.collect(req, now, ticket)
	if followOnly {
		for i := range set.ready {
			if set.ready[i].ID == bound {
				return s.admit(set.ready[i], req, sessionKey, affinity, bound, now), "", nil
			}
		}
		// 根线程账号冷却、满载、停用或不在本次范围：只等待它恢复或会话迁移（CPR follow_only）
		return Account{}, bound, errBlocked
	}
	if len(set.ready) == 0 && len(set.blocked) == 0 {
		switch {
		case set.inScope > 0 && set.sessionExcluded == set.inScope:
			return Account{}, "", ErrSessionPolicyRestricted
		case set.exhausted > 0 && set.exhausted == set.inScope-set.sessionExcluded:
			return Account{}, "", ErrUsageLimitExhausted
		}
		return Account{}, "", ErrNoEligibleAccount
	}
	if owner := req.HistoryOwner; owner != "" && !req.Exclude[owner] {
		for i := range set.ready {
			if set.ready[i].ID == owner {
				return s.admit(set.ready[i], req, sessionKey, affinity, bound, now), "", nil
			}
		}
		for _, account := range set.blocked {
			if account.ID == owner {
				return Account{}, owner, errBlocked
			}
		}
	}
	var chosen *Account
	if bound != "" {
		// 会话主账号可用时优先于权重层（CPR preferred_account_overrides_weight）
		for i := range set.ready {
			if set.ready[i].ID == bound {
				chosen = &set.ready[i]
				break
			}
		}
		// 严格亲和：主账号只是暂时满载时排队等待它，不分流
		if chosen == nil && affinity == "strict" {
			for _, account := range set.blocked {
				if account.ID == bound {
					return Account{}, bound, errBlocked
				}
			}
		}
	}
	if chosen == nil && len(set.ready) > 0 {
		picked := s.pick(set.ready, req, now)
		chosen = &picked
	}
	if chosen == nil {
		return Account{}, s.pickQueue(set.blocked, req, now), errBlocked
	}
	return s.admit(*chosen, req, sessionKey, affinity, bound, now), "", nil
}

// admitUndo 记录一次准入的副作用，共享租约被拒时据此撤回（R5 审查 R5-2）。
type admitUndo struct {
	id         string
	usedAt     time.Time
	prevUsedAt time.Time
	rpm        bool
	sessionKey string
	binding    sessionBinding
	hadBinding bool
}

// rollbackAdmitLocked 撤回准入的副作用（在途计数由 releaseLease 归还）：RPM 样本、最近使用时刻、轮询游标与会话绑定。
func (s *Store) rollbackAdmitLocked(undo admitUndo) {
	if account, ok := s.accounts[undo.id]; ok && account.LastUsedAt.Equal(undo.usedAt) {
		account.LastUsedAt = undo.prevUsedAt
		s.accounts[undo.id] = account
	}
	if undo.rpm {
		samples := s.rpm[undo.id]
		for i := len(samples) - 1; i >= 0; i-- {
			if samples[i].Equal(undo.usedAt) {
				s.rpm[undo.id] = append(samples[:i:i], samples[i+1:]...)
				break
			}
		}
	}
	if s.sched.cursor > 0 {
		s.sched.cursor--
	}
	if undo.sessionKey != "" {
		if current, ok := s.sched.bindings[undo.sessionKey]; ok && current.expires.Equal(undo.usedAt.Add(s.sched.sessionTTL)) {
			if undo.hadBinding {
				s.sched.bindings[undo.sessionKey] = undo.binding
			} else {
				delete(s.sched.bindings, undo.sessionKey)
			}
		}
	}
}

// admit 取得账号租约并认领或续期会话绑定。
func (s *Store) admit(account Account, req selectRequest, sessionKey, affinity, bound string, now time.Time) Account {
	// 优先模式的主账号已不可恢复地失效时，绑定迁到本次实际账号，后续请求跟随新账号保住缓存（CPR 6de1beb1）
	if affinity == "preferred" && bound != "" && bound != account.ID && s.bindingStaleLocked(bound, req, now) {
		bound = ""
	}
	undo := admitUndo{id: account.ID, usedAt: now, prevUsedAt: account.LastUsedAt, rpm: account.MaxRPM > 0, sessionKey: sessionKey}
	if sessionKey != "" {
		undo.binding, undo.hadBinding = s.sched.bindings[sessionKey]
	}
	s.lastAdmit = undo
	if req.Guardian && s.sched.guardianLimit > 0 {
		account.GuardianInFlight++
	} else {
		account.InFlight++
	}
	account.LastUsedAt = now
	s.accounts[account.ID] = account
	if account.MaxRPM > 0 {
		s.rpm[account.ID] = append(s.rpm[account.ID], now)
	}
	s.sched.cursor++
	s.claimSession(sessionKey, affinity, bound, account.ID, now)
	return account
}

// bindingStaleLocked：主账号已删除、停用、暂停、凭据明确失效，或额度耗尽且恢复时间未知/超过本次排队时限时，
// 继续偏向它只会让每次请求都分流，缓存永远无法落到同一账号。只看原生通道；BPS 选号不改写绑定。
func (s *Store) bindingStaleLocked(id string, req selectRequest, now time.Time) bool {
	if req.BPS {
		return false
	}
	account, ok := s.accounts[id]
	if !ok || !account.Enabled || account.Paused || !credentialUsable(account, now) {
		return true
	}
	if account.CooldownReason == string(categoryUsageLimit) || account.CooldownReason == string(categoryQuotaExhausted) {
		return account.CooldownUntil.IsZero() || account.CooldownUntil.Sub(now) > req.Policy.waitTimeout()
	}
	return false
}

// claimSession 在准入时（发送前）认领或续期会话绑定：
// 宽松与严格模式更新为实际账号；优先模式只做首次认领，临时分流不改写主账号。
func (s *Store) claimSession(key, affinity, bound, accountID string, now time.Time) {
	if key == "" {
		return
	}
	target := accountID
	if affinity == "preferred" && bound != "" {
		target = bound
	}
	s.sched.bindings[key] = sessionBinding{account: target, expires: now.Add(s.sched.sessionTTL)}
	if len(s.sched.bindings) > maxSessionBindings {
		for k, binding := range s.sched.bindings {
			if !binding.expires.After(now) {
				delete(s.sched.bindings, k)
			}
		}
		for k := range s.sched.bindings {
			if len(s.sched.bindings) <= maxSessionBindings*9/10 {
				break
			}
			delete(s.sched.bindings, k)
		}
	}
}

func highestWeight(accounts []Account) int {
	best := 0
	for _, account := range accounts {
		best = max(best, account.Weight)
	}
	return best
}

// pick 在最高权重层内按策略选号。
func (s *Store) pick(ready []Account, req selectRequest, now time.Time) Account {
	top := highestWeight(ready)
	tier := make([]Account, 0, len(ready))
	for _, account := range ready {
		if account.Weight == top {
			tier = append(tier, account)
		}
	}
	switch req.Policy.strategy() {
	case "quota_reset_priority":
		sort.SliceStable(tier, func(i, j int) bool {
			ri, rj := earliestReset(tier[i].Quota, now), earliestReset(tier[j].Quota, now)
			if ri.IsZero() != rj.IsZero() {
				return !ri.IsZero()
			}
			if !ri.Equal(rj) {
				return ri.Before(rj)
			}
			ui, uj := s.utilization(tier[i], req.Guardian), s.utilization(tier[j], req.Guardian)
			if ui != uj {
				return ui < uj
			}
			if !tier[i].LastUsedAt.Equal(tier[j].LastUsedAt) {
				return tier[i].LastUsedAt.Before(tier[j].LastUsedAt)
			}
			return tier[i].ID < tier[j].ID
		})
		return tier[0]
	case "round_robin":
		sort.Slice(tier, func(i, j int) bool { return tier[i].ID < tier[j].ID })
		return tier[s.sched.cursor%uint64(len(tier))]
	case "sticky":
		sort.Slice(tier, func(i, j int) bool {
			if !tier[i].LastUsedAt.Equal(tier[j].LastUsedAt) {
				return tier[i].LastUsedAt.After(tier[j].LastUsedAt)
			}
			return tier[i].ID < tier[j].ID
		})
		return tier[0]
	}
	type scored struct {
		account Account
		score   float64
	}
	ranked := make([]scored, 0, len(tier))
	best := math.Inf(-1)
	for _, account := range tier {
		score := s.smartScore(account, req, now)
		ranked = append(ranked, scored{account, score})
		best = math.Max(best, score)
	}
	tolerance := req.Policy.scoreTolerance()
	near := ranked[:0]
	for _, item := range ranked {
		if best-item.score <= tolerance {
			near = append(near, item)
		}
	}
	// 近似最优集合内按 ID 稳定轮换，避免分数轻微交错时反复命中同一账号
	sort.Slice(near, func(i, j int) bool { return near[i].account.ID < near[j].account.ID })
	return near[s.sched.cursor%uint64(len(near))].account
}

func (s *Store) utilization(account Account, guardian bool) float64 {
	used, limit := s.inFlight(account, guardian)
	if limit <= 0 {
		return 0
	}
	return float64(used) / float64(limit)
}

func (s *Store) smartScore(account Account, req selectRequest, now time.Time) float64 {
	p := req.Policy
	load := 1 - math.Min(math.Max(s.utilization(account, req.Guardian), 0), 1)
	quota := 0.5
	if remaining, ok := quotaRemaining(account.Quota, now); ok {
		quota = remaining
	}
	health, latency := 1.0, 1.0
	if feedback := s.sched.feedback[account.ID]; feedback != nil {
		health = 1 - math.Min(feedback.failureAt(now), 1)
		if feedback.firstOutputMS > 0 {
			latency = smartLatencyHalfScoreMS / (smartLatencyHalfScoreMS + feedback.firstOutputMS)
		}
	}
	reset := 0.0
	if at := earliestReset(account.Quota, now); !at.IsZero() {
		reset = smartResetHalfScoreSec / (smartResetHalfScoreSec + at.Sub(now).Seconds())
	}
	return p.weight("load")*load + p.weight("quota")*quota + p.weight("health")*health + p.weight("latency")*latency + p.weight("reset")*reset
}

// pickQueue 选择等待队列：最短队列优先，同长时按 smart 分数与 ID。
func (s *Store) pickQueue(blocked []Account, req selectRequest, now time.Time) string {
	guardianPool := req.Guardian && s.sched.guardianLimit > 0
	sort.SliceStable(blocked, func(i, j int) bool {
		qi := len(s.sched.queues[queueKey{blocked[i].ID, guardianPool}])
		qj := len(s.sched.queues[queueKey{blocked[j].ID, guardianPool}])
		if qi != qj {
			return qi < qj
		}
		// 同样的队长按 CPR wait_candidates 的顺序：权重高者优先，再按账号 ID
		if blocked[i].Weight != blocked[j].Weight {
			return blocked[i].Weight > blocked[j].Weight
		}
		return blocked[i].ID < blocked[j].ID
	})
	return blocked[0].ID
}

func (s *Store) pruneRPM(now time.Time) {
	for id, samples := range s.rpm {
		kept := samples[:0]
		for _, at := range samples {
			if now.Sub(at) < time.Minute {
				kept = append(kept, at)
			}
		}
		if len(kept) == 0 {
			delete(s.rpm, id)
		} else {
			s.rpm[id] = kept
		}
	}
}

// Acquire 选号并取得租约；账号都满载时按账号 FIFO 有界等待。deadline 为请求级共享等待预算，
// 首次入队时设置，换号与重试不重置。
func (s *Store) Acquire(ctx context.Context, req selectRequest, deadline *time.Time) (Account, error) {
	var ticket *waitTicket
	defer func() {
		if ticket != nil {
			s.mu.Lock()
			s.dequeueLocked(ticket)
			s.mu.Unlock()
		}
	}()
	for {
		now := time.Now()
		s.mu.Lock()
		account, queueAccount, err := s.trySelect(req, now, ticket)
		if err == nil {
			if ticket != nil {
				s.dequeueLocked(ticket)
				ticket = nil
			}
			s.mu.Unlock()
			return account, nil
		}
		if !errors.Is(err, errBlocked) {
			s.mu.Unlock()
			return Account{}, err
		}
		if req.NoWait {
			s.mu.Unlock()
			return Account{}, ErrNoEligibleAccount
		}
		if ticket == nil || ticket.account != queueAccount {
			if ticket != nil {
				s.dequeueLocked(ticket)
				ticket = nil
			}
			guardianPool := req.Guardian && s.sched.guardianLimit > 0
			key := queueKey{queueAccount, guardianPool}
			maxWaiting := s.sched.maxWaitingPerAccount
			if req.followsSession() && maxWaiting <= 0 {
				maxWaiting = followOnlyMaxWaiting
			}
			if maxWaiting <= 0 {
				s.mu.Unlock()
				return Account{}, ErrAccountCapacityUnavailable
			}
			// 审批请求可越过单账号排队上限，但仍受总等待容量约束
			if (!guardianPool && len(s.sched.queues[key]) >= maxWaiting) || s.sched.waiting >= maxWaitersPerWorker {
				s.mu.Unlock()
				return Account{}, ErrQueueFull
			}
			if deadline.IsZero() {
				timeout := req.Policy.waitTimeout()
				if req.followsSession() && req.Policy.WaitTimeoutMS <= 0 {
					timeout = followOnlyWaitTimeout
				}
				*deadline = now.Add(timeout)
			}
			ticket = &waitTicket{account: queueAccount, guardian: guardianPool, wake: make(chan struct{}, 1)}
			s.sched.queues[key] = append(s.sched.queues[key], ticket)
			s.sched.waiting++
		}
		wake := ticket.wake
		s.mu.Unlock()
		remaining := time.Until(*deadline)
		if remaining <= 0 {
			return Account{}, ErrQueueTimeout
		}
		timer := time.NewTimer(min(remaining, waitRecheckInterval))
		select {
		case <-ctx.Done():
			timer.Stop()
			return Account{}, ctx.Err()
		case <-wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// dequeueLocked 移除等待者；若它是队首则唤醒新的队首。
func (s *Store) dequeueLocked(ticket *waitTicket) {
	key := queueKey{ticket.account, ticket.guardian}
	queue := s.sched.queues[key]
	for i, item := range queue {
		if item != ticket {
			continue
		}
		queue = append(queue[:i], queue[i+1:]...)
		s.sched.waiting--
		if len(queue) == 0 {
			delete(s.sched.queues, key)
		} else {
			s.sched.queues[key] = queue
			if i == 0 {
				notify(queue[0])
			}
		}
		return
	}
}

func notify(ticket *waitTicket) {
	select {
	case ticket.wake <- struct{}{}:
	default:
	}
}

// wakeLocked 账号释放容量后唤醒该账号对应池的队首。
func (s *Store) wakeLocked(id string, guardian bool) {
	if queue := s.sched.queues[queueKey{id, guardian}]; len(queue) > 0 {
		notify(queue[0])
	}
}

// ReleaseLease 归还租约；guardian 表示该租约占用的是审批池。
func (s *Store) ReleaseLease(id string, guardian bool, errValue string) {
	s.releaseLease(id, guardian, errValue)
}

// releaseLease 归还本地租约。
func (s *Store) releaseLease(id string, guardian bool, errValue string) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	changed := false
	guardianPool := guardian && s.sched.guardianLimit > 0
	if ok {
		if guardianPool {
			if account.GuardianInFlight > 0 {
				account.GuardianInFlight--
			}
		} else if account.InFlight > 0 {
			account.InFlight--
		}
		if errValue != "" && errValue != account.LastError {
			account.LastError = errValue
			changed = true
		}
		s.accounts[id] = account
		s.wakeLocked(id, guardianPool)
	}
	s.mu.Unlock()
	if changed {
		s.persistSoon()
	}
}

func earliestReset(quota map[string]any, now time.Time) time.Time {
	var earliest time.Time
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, ok := quota[key].(map[string]any)
		if !ok {
			continue
		}
		reset, _ := window["reset_at"].(string)
		at, err := time.Parse(time.RFC3339Nano, reset)
		if err != nil || !at.After(now) {
			continue
		}
		if earliest.IsZero() || at.Before(earliest) {
			earliest = at
		}
	}
	return earliest
}

// quotaRemaining 取各窗口剩余比例的最小值；没有任何窗口观测时未知。
func quotaRemaining(quota map[string]any, now time.Time) (float64, bool) {
	remaining, known := 1.0, false
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, ok := quota[key].(map[string]any)
		if !ok {
			continue
		}
		used, ok := window["used_percent"].(float64)
		if !ok {
			continue
		}
		// 已过重置时间的窗口不再代表当前额度
		if reset, _ := window["reset_at"].(string); reset != "" {
			if at, err := time.Parse(time.RFC3339Nano, reset); err == nil && !at.After(now) {
				continue
			}
		}
		known = true
		remaining = math.Min(remaining, math.Max(0, 100-used)/100)
	}
	return remaining, known
}

// clientIdentityParts 取出客户端身份字段的来源：请求头、client_metadata、x-codex-turn-metadata，与首个非空文本。
func clientIdentityParts(headers map[string]string, body map[string]any) (header func(string) string, metadata, turn map[string]any, text func(...any) string) {
	header = func(name string) string {
		for key, value := range headers {
			if strings.EqualFold(key, name) {
				return strings.TrimSpace(value)
			}
		}
		return ""
	}
	metadata, _ = body["client_metadata"].(map[string]any)
	if raw := header("x-codex-turn-metadata"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &turn)
	}
	text = func(values ...any) string {
		for _, value := range values {
			if s, _ := value.(string); strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
		return ""
	}
	return header, metadata, turn, text
}

// followsSession 对齐 CPR follows_session_with_headers：能识别出的后代线程（会话与线程身份都在且不同）或
// 带 subagent_kind 的子代理请求；没有身份的普通客户端不受限。
func followsSession(headers map[string]string, body map[string]any) bool {
	header, metadata, turn, text := clientIdentityParts(headers, body)
	session := text(turn["session_id"], metadata["session_id"], header("session-id"), body["session_id"])
	thread := text(turn["thread_id"], header("thread-id"), metadata["thread_id"], body["thread_id"])
	if session != "" && thread != "" {
		return session != thread
	}
	return text(body["subagent_kind"], metadata["x-openai-subagent"], header("x-openai-subagent"), turn["subagent_kind"]) != ""
}

// isGuardianRequest：subagent_kind 或 client_metadata/x-openai-subagent 为 guardian。
func isGuardianRequest(envelope Envelope, body map[string]any) bool {
	for key, value := range envelope.Headers {
		if strings.EqualFold(key, "x-openai-subagent") && strings.EqualFold(strings.TrimSpace(value), "guardian") {
			return true
		}
	}
	if kind, _ := body["subagent_kind"].(string); strings.EqualFold(kind, "guardian") {
		return true
	}
	if metadata, ok := body["client_metadata"].(map[string]any); ok {
		if kind, _ := metadata["x-openai-subagent"].(string); strings.EqualFold(kind, "guardian") {
			return true
		}
	}
	return false
}

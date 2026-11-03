package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// 账号错误保护（对齐 codex-proxy-rs account/error_protection + freeze_recovery）：
// 策略由控制面在 Envelope 中下发（与 Node account-error-protection.mjs 的规范化结构同形），
// Worker 按“账号 × 凭据修订 × 策略指纹”逐次尝试计数，达到阈值冻结；到期后需探测成功才解冻（探测开启时），
// 探测失败按冻结时长顺延。完整成功的普通调用清除未冻结的证据；探测与预热不计数。
type ProtectionPolicy struct {
	Enabled      bool             `json:"enabled"`
	Threshold    int              `json:"threshold"`
	WindowMs     int64            `json:"windowMs"`
	DurationMs   int64            `json:"durationMs"`
	ProbeEnabled bool             `json:"probeEnabled"`
	ProbeModel   *string          `json:"probeModel"`
	Rules        []ProtectionRule `json:"rules"`
	Fingerprint  string           `json:"fingerprint"`
}

type ProtectionRule struct {
	ID         string                `json:"id"`
	Name       string                `json:"name"`
	Conditions []ProtectionCondition `json:"conditions"`
}

type ProtectionCondition struct {
	Field      string    `json:"field"`
	Operator   string    `json:"operator"`
	Values     []*string `json:"values"`
	IgnoreCase bool      `json:"ignoreCase"`
}

type ProtectionMatch struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ProtectionState 是账号的保护运行态；只保存规则标识，不保存上游错误正文。
type ProtectionState struct {
	PolicyFingerprint  string            `json:"policy_fingerprint,omitempty"`
	CredentialRevision int64             `json:"credential_revision"`
	Count              int               `json:"count,omitempty"`
	CountUntil         time.Time         `json:"count_until,omitempty"`
	Version            int64             `json:"version,omitempty"`
	FrozenUntil        time.Time         `json:"frozen_until,omitempty"`
	RequiresProbe      bool              `json:"requires_probe,omitempty"`
	DurationMs         int64             `json:"duration_ms,omitempty"`
	ProbeModel         string            `json:"probe_model,omitempty"`
	Rules              []ProtectionMatch `json:"rules,omitempty"`
	LastProbeAt        time.Time         `json:"last_probe_at,omitempty"`
	LastProbeError     string            `json:"last_probe_error,omitempty"`
}

const (
	protectionMessagePrefixBytes = 8 << 10
	protectionFieldPrefixBytes   = 1024
	protectionRecoveryInterval   = 30 * time.Second
	protectionProbeTimeout       = 60 * time.Second
)

func (p *ProtectionPolicy) valid() bool {
	if p == nil || p.Threshold < 2 || p.Threshold > 1000 || p.WindowMs < 60_000 || p.WindowMs > 3_600_000 ||
		p.DurationMs < 300_000 || p.DurationMs > 604_800_000 || len(p.Rules) > 32 || p.Fingerprint == "" {
		return false
	}
	return !p.Enabled || len(p.Rules) > 0
}

func (p *ProtectionPolicy) probeModel() string {
	if p == nil || p.ProbeModel == nil {
		return ""
	}
	return strings.TrimSpace(*p.ProbeModel)
}

// matchingRules 只观察解析后的上游事实：provider/status/code/type/message（message 只看前 8 KiB）。
func (p *ProtectionPolicy) matchingRules(failure upstreamFailure) []ProtectionMatch {
	if p == nil || !p.Enabled {
		return nil
	}
	facts := map[string]*string{"provider": strPtr("openai")}
	if failure.Status > 0 {
		facts["status"] = strPtr(fmt.Sprint(failure.Status))
	}
	if failure.Code != "" {
		facts["code"] = strPtr(prefixBytes(failure.Code, protectionFieldPrefixBytes))
	}
	if failure.Type != "" {
		facts["type"] = strPtr(prefixBytes(failure.Type, protectionFieldPrefixBytes))
	}
	if failure.Message != "" {
		facts["message"] = strPtr(prefixBytes(failure.Message, protectionMessagePrefixBytes))
	}
	var out []ProtectionMatch
	for _, rule := range p.Rules {
		if len(rule.Conditions) == 0 {
			continue
		}
		ok := true
		for _, condition := range rule.Conditions {
			if !condition.matches(facts[condition.Field]) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, ProtectionMatch{ID: rule.ID, Name: rule.Name})
		}
	}
	return out
}

func (c ProtectionCondition) matches(actual *string) bool {
	normalize := func(value string) string {
		value = strings.TrimSpace(value)
		if c.IgnoreCase {
			return strings.ToLower(value)
		}
		return value
	}
	for _, candidate := range c.Values {
		switch {
		case candidate == nil && actual == nil:
			if c.Operator == "equals" {
				return true
			}
		case candidate == nil || actual == nil:
		case c.Operator == "contains":
			expected := normalize(*candidate)
			if expected != "" && strings.Contains(normalize(*actual), expected) {
				return true
			}
		default:
			if normalize(*actual) == normalize(*candidate) {
				return true
			}
		}
	}
	return false
}

func strPtr(value string) *string { return &value }

func prefixBytes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && (value[end]&0xc0) == 0x80 {
		end--
	}
	return value[:end]
}

// protectionFrozen：冻结未到期，或到期但仍等待探测（凭据修订变化后旧冻结失效）。
func protectionFrozen(account Account, now time.Time) bool {
	state := account.Protection
	if state == nil || state.FrozenUntil.IsZero() || state.CredentialRevision != account.CredentialRevision {
		return false
	}
	return now.Before(state.FrozenUntil) || state.RequiresProbe
}

// protectionCountable：预热（generate=false 或 request_kind=prewarm）不计入保护证据。
func protectionCountable(body []byte) bool {
	var fields struct {
		Generate       *bool `json:"generate"`
		ClientMetadata struct {
			RequestKind string `json:"request_kind"`
		} `json:"client_metadata"`
	}
	if json.Unmarshal(body, &fields) != nil {
		return true
	}
	return !(fields.Generate != nil && !*fields.Generate) && fields.ClientMetadata.RequestKind != "prewarm"
}

// ProtectionVersion 返回开始执行时的证据版本，用于成功时只清除期间没有新增失败的证据。
func (s *Store) ProtectionVersion(id string) int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if state := s.accounts[id].Protection; state != nil {
		return state.Version
	}
	return 0
}

// RecordProtectionFailure 记录一次命中规则的上游失败；达到阈值时冻结并返回 true。
func (s *Store) RecordProtectionFailure(id string, policy *ProtectionPolicy, matched []ProtectionMatch, now time.Time) bool {
	if policy == nil || !policy.Enabled || len(matched) == 0 {
		return false
	}
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok || protectionFrozen(account, now) {
		s.mu.Unlock()
		return false
	}
	state := ProtectionState{}
	if account.Protection != nil {
		state = *account.Protection
	}
	if state.PolicyFingerprint != policy.Fingerprint || state.CredentialRevision != account.CredentialRevision {
		state = ProtectionState{Version: state.Version}
	}
	state.PolicyFingerprint = policy.Fingerprint
	state.CredentialRevision = account.CredentialRevision
	state.FrozenUntil, state.RequiresProbe = time.Time{}, false
	if !state.CountUntil.After(now) {
		state.Count = 0
	}
	state.Count++
	state.CountUntil = now.Add(time.Duration(policy.WindowMs) * time.Millisecond)
	state.Version++
	frozen := state.Count >= policy.Threshold
	if frozen {
		state.Count = 0
		state.CountUntil = time.Time{}
		state.FrozenUntil = now.Add(time.Duration(policy.DurationMs) * time.Millisecond)
		state.RequiresProbe = policy.ProbeEnabled
		state.DurationMs = policy.DurationMs
		state.ProbeModel = policy.probeModel()
		state.Rules = matched
		names := make([]string, len(matched))
		for i, rule := range matched {
			names[i] = rule.Name
		}
		account.LastError = "error_protection: " + strings.Join(names, ", ")
	}
	account.Protection = &state
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	_ = s.persist()
	return frozen
}

// RecordProtectionSuccess：完整成功的普通调用清除未冻结的计数（执行期间有新失败时不清除）。
func (s *Store) RecordProtectionSuccess(id string, version int64) {
	s.mu.Lock()
	account, ok := s.accounts[id]
	state := account.Protection
	if !ok || state == nil || state.Count == 0 || state.Version != version || protectionFrozen(account, time.Now()) {
		s.mu.Unlock()
		return
	}
	next := *state
	next.Count, next.CountUntil = 0, time.Time{}
	next.Version++
	account.Protection = &next
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	_ = s.persist()
}

// FinishFreeze 按冻结快照结束（postpone 为零）或顺延冻结；快照已变化（人工恢复、新冻结）时不改动。
func (s *Store) FinishFreeze(id string, expected time.Time, postpone time.Time, probeErr string) bool {
	s.mu.Lock()
	account, ok := s.accounts[id]
	if !ok || account.Protection == nil || !account.Protection.FrozenUntil.Equal(expected) {
		s.mu.Unlock()
		return false
	}
	next := *account.Protection
	next.LastProbeAt = time.Now().UTC()
	next.LastProbeError = probeErr
	if postpone.IsZero() {
		next.FrozenUntil, next.RequiresProbe, next.Rules = time.Time{}, false, nil
		if strings.HasPrefix(account.LastError, "error_protection:") {
			account.LastError = ""
		}
	} else {
		next.FrozenUntil = postpone
	}
	next.Version++
	account.Protection = &next
	account.RuntimeRevision++
	s.accounts[id] = account
	s.mu.Unlock()
	_ = s.persist()
	return true
}

func clearProtection(account *Account) {
	if account.Protection == nil {
		return
	}
	next := *account.Protection
	next.Count, next.CountUntil = 0, time.Time{}
	next.FrozenUntil, next.RequiresProbe, next.Rules = time.Time{}, false, nil
	next.Version++
	account.Protection = &next
}

// protectionPolicies 保存最近一次控制面下发的策略（持久化，供重启后的到期探测使用）。
type protectionPolicies struct {
	mu     sync.RWMutex
	path   string
	policy *ProtectionPolicy
}

func loadProtectionPolicies(path string) *protectionPolicies {
	out := &protectionPolicies{path: path}
	if data, err := os.ReadFile(path); err == nil {
		var policy ProtectionPolicy
		if json.Unmarshal(data, &policy) == nil && policy.valid() {
			out.policy = &policy
		}
	}
	return out
}

func (p *protectionPolicies) current() *ProtectionPolicy {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.policy
}

// observe 采用信封中的策略；无效策略按关闭处理（不能把未知配置当作允许冻结）。
func (p *protectionPolicies) observe(policy *ProtectionPolicy) *ProtectionPolicy {
	if policy == nil {
		return nil
	}
	if !policy.valid() {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.policy == nil || p.policy.Fingerprint != policy.Fingerprint {
		copied := *policy
		p.policy = &copied
		if data, err := json.Marshal(copied); err == nil && p.path != "" {
			_ = writeFileAtomic(p.path, data)
		}
	}
	return p.policy
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Server) protectionLoop(ctx context.Context) {
	ticker := time.NewTicker(protectionRecoveryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.recoverDueFreezes(ctx, time.Now())
		}
	}
}

// recoverDueFreezes 只处理已到期的冻结：探测开启时探测成功才解冻、失败顺延；关闭保护或探测时直接解冻。
// 停用账号不自动恢复；凭据修订变化后旧冻结直接结束。
func (s *Server) recoverDueFreezes(ctx context.Context, now time.Time) {
	policy := s.protection.current()
	for _, account := range s.store.snapshot() {
		state := account.Protection
		if state == nil || state.FrozenUntil.IsZero() || now.Before(state.FrozenUntil) {
			continue
		}
		if state.CredentialRevision != account.CredentialRevision {
			s.store.FinishFreeze(account.ID, state.FrozenUntil, time.Time{}, "")
			continue
		}
		if !(policy != nil && policy.Enabled && policy.ProbeEnabled && state.RequiresProbe) {
			s.store.FinishFreeze(account.ID, state.FrozenUntil, time.Time{}, "")
			continue
		}
		if !account.Enabled || account.Paused {
			continue
		}
		err := s.probeAccount(ctx, account, state.ProbeModel, policy)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			s.store.FinishFreeze(account.ID, state.FrozenUntil, time.Time{}, "")
			continue
		}
		duration := time.Duration(state.DurationMs) * time.Millisecond
		if duration <= 0 {
			duration = time.Duration(policy.DurationMs) * time.Millisecond
		}
		s.store.FinishFreeze(account.ID, state.FrozenUntil, time.Now().Add(duration), err.Error())
	}
}

// probeAccount 发送一个最小 Responses 请求，以 response.completed 判定成功；不计入保护证据。
func (s *Server) probeAccount(ctx context.Context, account Account, model string, policy *ProtectionPolicy) error {
	ctx, cancel := context.WithTimeout(ctx, protectionProbeTimeout)
	defer cancel()
	if model == "" {
		model = policy.probeModel()
	}
	if model == "" {
		catalog, err := s.fetchCatalogWith(ctx, account, s.globalProfile().CodexVersion)
		if err != nil {
			return fmt.Errorf("probe model unavailable: %w", err)
		}
		var parsed struct {
			Models []struct {
				Slug string `json:"slug"`
				ID   string `json:"id"`
			} `json:"models"`
		}
		if json.Unmarshal(catalog, &parsed) == nil && len(parsed.Models) > 0 {
			model = parsed.Models[0].Slug
			if model == "" {
				model = parsed.Models[0].ID
			}
		}
		if model == "" {
			return errors.New("probe model unavailable")
		}
	}
	body, _ := json.Marshal(map[string]any{
		"model":        model,
		"instructions": "",
		"input":        []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "ping"}}}},
		"tools":        []any{},
		"store":        false,
		"stream":       true,
	})
	_, _, err := s.auxiliaryResponse(ctx, account, body, 1<<20)
	return err
}

// PeerFreeze 记录来源实例、冻结截止与原因；本实例不计数、不探测。
type PeerFreeze struct {
	Until  time.Time `json:"until"`
	Source string    `json:"source,omitempty"`
	Reason string    `json:"reason,omitempty"`
}

const pendingProbeReportWindow = 90 * time.Second

func peerFrozen(account Account, now time.Time) bool {
	return account.PeerFreeze != nil && now.Before(account.PeerFreeze.Until)
}

// localFreezes 是心跳上报的本实例冻结集合；等待探测的到期冻结按短窗口续报，直到探测解冻。
func (s *Store) localFreezes(now time.Time) []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []map[string]any{}
	for id, account := range s.accounts {
		if !protectionFrozen(account, now) {
			continue
		}
		until := account.Protection.FrozenUntil
		if !until.After(now) {
			until = now.Add(pendingProbeReportWindow)
		}
		names := make([]string, 0, len(account.Protection.Rules))
		for _, rule := range account.Protection.Rules {
			names = append(names, rule.Name)
		}
		out = append(out, map[string]any{"account_id": id, "frozen_until": until.UTC().Format(time.RFC3339Nano), "reason": strings.Join(names, ", ")})
	}
	return out
}

// ApplyPeerFreezes 以控制面下发的完整集合替换其他实例的冻结；未出现的账号解除 PeerFreeze。
func (s *Store) ApplyPeerFreezes(freezes map[string]PeerFreeze) {
	s.mu.Lock()
	changed := false
	for id, account := range s.accounts {
		next, ok := freezes[id]
		switch {
		case ok && (account.PeerFreeze == nil || *account.PeerFreeze != next):
			freeze := next
			account.PeerFreeze = &freeze
		case !ok && account.PeerFreeze != nil:
			account.PeerFreeze = nil
		default:
			continue
		}
		account.RuntimeRevision++
		s.accounts[id] = account
		changed = true
	}
	s.mu.Unlock()
	if changed {
		_ = s.persist()
	}
}

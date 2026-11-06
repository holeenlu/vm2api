package codexgateway

import (
	"context"
	"encoding/json"
	"log"
	"reflect"
	"sort"
	"sync"
	"time"
)

// 影子比对（设计第 19 节 G2）：把直读的事实与投影来的账号逐项比较，结果随健康接口与心跳上报。
// 不改变调度：G2 期间调度仍用投影；生产影子运行零差异后才进入 G3（以库为准）。
// 刷新轮换后到控制面写入凭据库之间的短暂代次差异属于正常，连续出现才需要排查。

const (
	factsShadowInterval = 30 * time.Second
	factsShadowMaxItems = 20
)

type factsMismatch struct {
	Account string   `json:"account"`
	Fields  []string `json:"fields"`
}

// FactsShadow 是一次比对的结果。
type FactsShadow struct {
	CheckedAt      string          `json:"checked_at,omitempty"`
	Matched        int             `json:"matched"`
	Mismatched     int             `json:"mismatched"`
	Items          []factsMismatch `json:"items,omitempty"`
	MissingInStore []string        `json:"missing_in_store,omitempty"`
	MissingInFacts []string        `json:"missing_in_facts,omitempty"`
	FactErrors     []factsMismatch `json:"fact_errors,omitempty"`
}

type factsState struct {
	reader *FactsReader
	// primary：事实合并进账号表（以库为准，G3）；否则只做影子比对
	primary bool
	mu      sync.RWMutex
	shadow  FactsShadow
}

// startFacts 在配置了事实库时启动读取器与影子比对（KIN_CODEX_GATEWAY_FACTS=off 关闭）。
func (s *Server) startFacts(ctx context.Context) {
	if s.facts == nil {
		return
	}
	if s.facts.primary {
		s.facts.reader.onChange = func(facts map[string]AccountFacts) {
			// 等待中的选号每 250ms 复查一次，合并后的变化随之生效
			if _, err := s.store.ApplyFacts(facts); err != nil {
				log.Printf("codex-gateway: applying facts failed: %v", err)
			}
		}
	}
	go s.facts.reader.Run(ctx)
	go func() {
		ticker := time.NewTicker(factsShadowInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.compareFacts()
			}
		}
	}()
}

func (s *Server) compareFacts() FactsShadow {
	if s.facts == nil {
		return FactsShadow{}
	}
	facts, status := s.facts.reader.Snapshot()
	if status.LoadedAt == "" {
		return FactsShadow{}
	}
	// 必须用含凭据的内部副本：List() 是对外视图，令牌、代理、BPS 令牌与安装身份都已清空
	result := compareFactsWithStore(facts, s.store.snapshot(), time.Now())
	s.facts.mu.Lock()
	previous := s.facts.shadow.Mismatched
	s.facts.shadow = result
	s.facts.mu.Unlock()
	if result.Mismatched > 0 && result.Mismatched != previous {
		data, _ := json.Marshal(result.Items)
		log.Printf("codex-gateway: facts shadow mismatches %d: %s", result.Mismatched, data)
	}
	return result
}

// factsStatus 是健康接口与心跳里的 facts 字段；未启用时为 nil。
func (s *Server) factsStatus() map[string]any {
	if s.facts == nil {
		return nil
	}
	_, status := s.facts.reader.Snapshot()
	s.facts.mu.RLock()
	shadow := s.facts.shadow
	s.facts.mu.RUnlock()
	mode := "shadow"
	if s.facts.primary {
		mode = "primary"
	}
	return map[string]any{"mode": mode, "status": status, "shadow": shadow}
}

func sortedCopy(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(sortedCopy(a), sortedCopy(b))
}

// compareFactsWithStore 逐账号比较事实与投影账号（按运行账号 ID 对应）。
func compareFactsWithStore(facts map[string]AccountFacts, accounts []Account, now time.Time) FactsShadow {
	result := FactsShadow{CheckedAt: now.UTC().Format(time.RFC3339)}
	byRuntime := make(map[string]Account, len(accounts))
	for _, account := range accounts {
		byRuntime[account.ID] = account
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(facts))
	for id := range facts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		fact := facts[id]
		if fact.Deleted || fact.Archived || fact.Status == "archived" {
			continue
		}
		if len(fact.Errors) > 0 && len(result.FactErrors) < factsShadowMaxItems {
			result.FactErrors = append(result.FactErrors, factsMismatch{Account: id, Fields: fact.Errors})
		}
		account, ok := byRuntime[fact.RuntimeID]
		if !ok {
			// 还没有授权完成（没有凭据）的账号不会投影，不算缺失
			if fact.Native != nil && len(result.MissingInStore) < factsShadowMaxItems {
				result.MissingInStore = append(result.MissingInStore, id)
			}
			continue
		}
		seen[fact.RuntimeID] = true
		if fields := factsDiff(fact, account); len(fields) > 0 {
			result.Mismatched++
			if len(result.Items) < factsShadowMaxItems {
				result.Items = append(result.Items, factsMismatch{Account: id, Fields: fields})
			}
		} else {
			result.Matched++
		}
	}
	for _, account := range accounts {
		if !seen[account.ID] && account.Enabled && len(result.MissingInFacts) < factsShadowMaxItems {
			result.MissingInFacts = append(result.MissingInFacts, account.ID)
		}
	}
	return result
}

// factsDiff 列出事实与投影账号不一致的字段（只比较投影会下发的字段）。
func factsDiff(fact AccountFacts, account Account) []string {
	var fields []string
	add := func(name string, differ bool) {
		if differ {
			fields = append(fields, name)
		}
	}
	active := fact.Schedulable()
	add("enabled", account.Enabled != active)
	add("paused", account.Paused != !active)
	add("max_concurrency", account.MaxConcurrency != fact.MaxConcurrency)
	add("max_rpm", account.MaxRPM != fact.MaxRPM)
	add("weight", account.Weight != fact.Weight)
	add("models", !sameStrings(account.Models, fact.Models))
	add("denied_models", !sameStrings(account.DeniedModels, fact.DeniedModels))
	// 投影只给启用的账号下发分组；以库为准后由账号状态决定是否接单
	groups := fact.Groups
	if !active {
		groups = nil
	}
	add("groups", !sameStrings(account.Groups, groups))
	add("reset_credit_auto", account.ResetCreditAuto != fact.ResetCreditAuto)
	add("proxy_url", account.ProxyURL != fact.ProxyURL)
	add("proxy_max_websocket_connections", account.ProxyMaxWS != fact.ProxyMaxWS)
	add("request_location", !reflect.DeepEqual(account.RequestLocation, fact.RequestLocation))
	add("bps_settings", !sameBPSSettings(account.BPSSettings, fact.BPSSettings))
	add("installation_id", fact.InstallationID != "" && account.InstallationID != fact.InstallationID)
	if fact.Native != nil {
		add("credential_revision", account.CredentialRevision != fact.Native.Revision)
		add("refresh_token", account.RefreshToken != fact.Native.RefreshToken)
	} else {
		add("credential_missing", account.RefreshToken != "" || account.AccessToken != "" || account.APIKey != "")
	}
	hasBPS := account.BPS != nil && account.BPS.Revision > 0 && account.BPS.RefreshToken != ""
	switch {
	case fact.BPS == nil && hasBPS:
		add("bps_credential_missing", true)
	case fact.BPS != nil && !hasBPS:
		add("bps_credential_extra", true)
	case fact.BPS != nil && hasBPS:
		add("bps_token_generation", account.BPS.TokenGeneration != fact.BPS.Revision-1)
		add("bps_refresh_token", account.BPS.RefreshToken != fact.BPS.RefreshToken)
	}
	return fields
}

func sameBPSSettings(a, b *BPSSettings) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	x, y := *a, *b
	x.Models, y.Models = sortedCopy(x.Models), sortedCopy(y.Models)
	return reflect.DeepEqual(x, y)
}

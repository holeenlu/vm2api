package codexgateway

import (
	"reflect"
	"strconv"
	"time"
)

// 以库为准（设计第 19 节 G3，KIN_CODEX_GATEWAY_FACTS=primary）：直读的事实就是账号的配置与凭据来源。
// Store 仍是 Worker 的账号表与本地缓存（accounts.json，含运行态）；ApplyFacts 把事实合并进去：
//   - 配置（启停、并发、RPM、权重、模型范围、分组、自动重置卡、代理、请求位置、安装身份）以事实为准；
//   - 凭据只前进不后退：事实的原生代次更高时换入（期间重新授权或刷新报告已写库）；本地更高时保留本地
//     （本实例刚刷新、报告还没写库）；
//   - 运行态（在途、冷却、额度、保护、Cookie 等）属于 Worker，保留；
//   - 事实里没有的账号停止接单（不删除：授权完成到控制面落库之间的新账号仍在本地）；墓碑账号删除。
// 读取出错（主密钥缺失、密文校验失败）的账号保留上一份完好的配置与凭据，不以错误数据调度。

// ApplyFacts 把事实快照合并进账号表，返回有变化的账号数。
func (s *Store) ApplyFacts(facts map[string]AccountFacts) (int, error) {
	s.mu.Lock()
	byRuntime := make(map[string]AccountFacts, len(facts))
	for _, fact := range facts {
		if fact.RuntimeID != "" {
			byRuntime[fact.RuntimeID] = fact
		}
	}
	changed := 0
	for runtimeID, fact := range byRuntime {
		previous, exists := s.accounts[runtimeID]
		if fact.Deleted {
			if exists {
				delete(s.accounts, runtimeID)
				delete(s.rpm, runtimeID)
				delete(s.risk, runtimeID)
				changed++
			}
			continue
		}
		if len(fact.Errors) > 0 {
			// 读不出的字段保留上一份完好的配置与凭据，但“不可调度”方向照常生效（停用、归档不被读取错误挡住）
			if exists && !fact.Schedulable() && (previous.Enabled || !previous.Paused || len(previous.Groups) > 0) {
				next := previous
				next.Enabled, next.Paused, next.Groups = false, true, nil
				next.RuntimeRevision++
				s.accounts[runtimeID] = next
				changed++
			}
			continue
		}
		if !exists && fact.Native == nil {
			continue // 还没有凭据（授权未完成）
		}
		next := previous
		if !exists {
			next = Account{ID: runtimeID, AuthType: "oauth", RuntimeRevision: 1, MaxConcurrency: s.defaultConcurrency}
		}
		applyFactConfig(&next, fact)
		applyFactCredentials(&next, fact)
		if next.InstallationID == "" {
			next.InstallationID = newUUIDv4()
		}
		if next.MaxConcurrency <= 0 {
			next.MaxConcurrency = s.defaultConcurrency
		}
		if exists && reflect.DeepEqual(previous, next) {
			continue
		}
		next.RuntimeRevision++
		s.accounts[runtimeID] = next
		changed++
	}
	// 事实里没有的本地账号：停止接单、清空分组（控制面没有它，或它还没落库）
	for id, account := range s.accounts {
		if _, ok := byRuntime[id]; ok || (!account.Enabled && account.Paused && len(account.Groups) == 0) {
			continue
		}
		account.Enabled, account.Paused, account.Groups = false, true, nil
		account.RuntimeRevision++
		s.accounts[id] = account
		changed++
	}
	s.mu.Unlock()
	if changed == 0 {
		return 0, nil
	}
	return changed, s.persist()
}

func applyFactConfig(account *Account, fact AccountFacts) {
	active := fact.Schedulable()
	account.Enabled, account.Paused = active, !active
	account.MaxConcurrency = fact.MaxConcurrency
	account.MaxRPM = fact.MaxRPM
	account.Weight = fact.Weight
	account.Models = append([]string(nil), fact.Models...)
	account.DeniedModels = append([]string(nil), fact.DeniedModels...)
	account.Groups = nil
	if active {
		account.Groups = append([]string(nil), fact.Groups...)
	}
	account.ResetCreditAuto = fact.ResetCreditAuto
	account.ProxyURL = fact.ProxyURL
	account.ProxyMaxWS = fact.ProxyMaxWS
	account.RequestLocation = nil
	if fact.RequestLocation != nil {
		location := *fact.RequestLocation
		account.RequestLocation = &location
	}
	if fact.InstallationID != "" {
		account.InstallationID = fact.InstallationID
	}
	if fact.Email != "" {
		account.Email = fact.Email
	}
	if fact.ChatGPTAccountID != "" {
		account.ChatGPTAccountID = fact.ChatGPTAccountID
	}
	// 套餐以 Worker 观测（额度接口）为准；本地还没有时用控制面记录的
	if account.Plan == "" && fact.Plan != "" {
		account.Plan = fact.Plan
	}
}

func factExpiry(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds > 0 {
		return time.Unix(seconds, 0).UTC()
	}
	return time.Time{}
}

func applyFactCredentials(account *Account, fact AccountFacts) {
	if native := fact.Native; native != nil {
		hasLocal := account.RefreshToken != "" || account.AccessToken != "" || account.APIKey != ""
		sameTokens := native.RefreshToken == account.RefreshToken && native.AccessToken == account.AccessToken && native.APIKey == account.APIKey
		switch {
		case sameTokens && hasLocal:
			// 库里就是本地这份（含刚写回的刷新结果）：只记下来源代次
			if native.Revision >= account.CredentialRevision {
				account.CredentialRevision = native.Revision
			}
			account.CredentialBase = max(account.CredentialBase, native.Revision)
		case !hasLocal || native.Revision > account.CredentialRevision ||
			(account.CredentialBase != 0 && native.Revision != account.CredentialBase):
			// 库里更新，或库里已不是本地凭据来自的代次（控制面重新授权、导入；本地未写回的刷新作废）
			account.CredentialRevision, account.CredentialBase = native.Revision, native.Revision
			account.AccessToken, account.RefreshToken, account.IDToken, account.APIKey = native.AccessToken, native.RefreshToken, native.IDToken, native.APIKey
			account.ExpiresAt = factExpiry(native.ExpiresAt)
			if native.APIKey != "" {
				account.AuthType = "api_key"
			}
			resetCredentialRuntime(account)
		case account.CredentialBase == 0 && native.Revision == account.CredentialRevision:
			// 升级前的本地账号：库里与本地同代次时记下来源代次
			account.CredentialBase = native.Revision
		}
	}
}

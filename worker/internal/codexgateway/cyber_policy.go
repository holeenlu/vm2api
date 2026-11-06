package codexgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// cyber_policy 会话排除（对齐 codex-proxy-rs credential/selector.rs 与 affinity.rs）：上游以 4xx cyber_policy
// 拒绝时可安全重放并换号，同时在该会话内排除这个账号 1 小时；会话内全部候选都被排除时返回
// 400 cyber_policy（未发送、不重试）。会话中有一次成功响应即清除排除。会话只认显式的 session/conversation
// 或客户端给出的 prompt_cache_key，并按调用方范围隔离；续接（previous_response_id）不参与。
const (
	cyberPolicySessionTTL  = time.Hour
	maxCyberPolicySessions = 16384
)

type cyberPolicyExclusions struct {
	mu       sync.Mutex
	sessions map[string]map[string]time.Time
}

func newCyberPolicyExclusions() *cyberPolicyExclusions {
	return &cyberPolicyExclusions{sessions: map[string]map[string]time.Time{}}
}

func (c *cyberPolicyExclusions) excluded(key string, now time.Time) map[string]bool {
	if key == "" {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var out map[string]bool
	for account, until := range c.sessions[key] {
		if until.After(now) {
			if out == nil {
				out = map[string]bool{}
			}
			out[account] = true
		}
	}
	return out
}

func (c *cyberPolicyExclusions) record(key, account string, now time.Time) {
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	accounts := c.sessions[key]
	if accounts == nil {
		if len(c.sessions) >= maxCyberPolicySessions {
			c.pruneLocked(now)
		}
		accounts = map[string]time.Time{}
		c.sessions[key] = accounts
	}
	accounts[account] = now.Add(cyberPolicySessionTTL)
}

func (c *cyberPolicyExclusions) clear(key string) {
	if key == "" {
		return
	}
	c.mu.Lock()
	delete(c.sessions, key)
	c.mu.Unlock()
}

func (c *cyberPolicyExclusions) pruneLocked(now time.Time) {
	for key, accounts := range c.sessions {
		for account, until := range accounts {
			if !until.After(now) {
				delete(accounts, account)
			}
		}
		if len(accounts) == 0 {
			delete(c.sessions, key)
		}
	}
	for key := range c.sessions {
		if len(c.sessions) < maxCyberPolicySessions {
			break
		}
		delete(c.sessions, key)
	}
}

// cyberPolicy：4xx 且错误码为 cyber_policy（CPR is_cyber_policy_code）。
func (f upstreamFailure) cyberPolicy() bool {
	return f.Status >= 400 && f.Status < 500 && strings.EqualFold(strings.TrimSpace(f.Code), "cyber_policy")
}

// cyberPolicyKey 是本请求的 cyber_policy 会话键（CPR derive_codex_cyber_policy_session_key）；没有显式会话时为空。
func (d *dispatchRun) cyberPolicyKey() string {
	var fields struct {
		PreviousResponseID string `json:"previous_response_id"`
		PromptCacheKey     string `json:"prompt_cache_key"`
	}
	_ = json.Unmarshal(topLevelSubset(d.envelope.Body, "previous_response_id", "prompt_cache_key"), &fields)
	if strings.TrimSpace(fields.PreviousResponseID) != "" {
		return ""
	}
	session := strings.TrimSpace(d.envelope.Scope.SessionID)
	if session == "" {
		session = d.inboundHeader("session-id")
	}
	if session == "" {
		session = strings.TrimSpace(fields.PromptCacheKey)
	}
	if session == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("cyber-policy-session\x00" + d.envelope.ClientScope + "\x00" + session))
	return hex.EncodeToString(sum[:])
}

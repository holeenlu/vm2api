package codexgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// 客户端轮次重试抑制（对齐 codex-proxy-rs gateway-core engine/client_retry.rs）：同一调用方的同一客户端轮次
// （thread + turn）在 300 秒内已因 503 server_error 耗尽同号退避而失败交付时，后续重试跳过同号退避直接交付，
// 避免客户端每重试一次上游就多承受一轮退避。该轮次成功完成即清除；标记只在本进程内、可丢失。
const (
	clientRetryFailureTTL = 300 * time.Second
	maxClientRetryEntries = 16384
)

type clientRetryFailures struct {
	mu      sync.Mutex
	entries map[string]time.Time
}

func newClientRetryFailures() *clientRetryFailures {
	return &clientRetryFailures{entries: map[string]time.Time{}}
}

func (c *clientRetryFailures) has(key string, now time.Time) bool {
	if key == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	until, ok := c.entries[key]
	return ok && until.After(now)
}

func (c *clientRetryFailures) record(key string, now time.Time) {
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= maxClientRetryEntries {
		for k, until := range c.entries {
			if !until.After(now) {
				delete(c.entries, k)
			}
		}
		for k := range c.entries {
			if len(c.entries) < maxClientRetryEntries {
				break
			}
			delete(c.entries, k)
		}
	}
	c.entries[key] = now.Add(clientRetryFailureTTL)
}

func (c *clientRetryFailures) clear(key string) {
	if key == "" {
		return
	}
	c.mu.Lock()
	delete(c.entries, key)
	c.mu.Unlock()
}

// clientTurnKey 是调用方范围 + 客户端轮次的键；线程或轮次 ID 缺失时为空（不参与抑制）。
func (d *dispatchRun) clientTurnKey() string {
	var turn map[string]any
	if raw := d.inboundHeader("x-codex-turn-metadata"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &turn)
	}
	var fields struct {
		ClientMetadata map[string]any `json:"client_metadata"`
	}
	_ = json.Unmarshal(topLevelSubset(d.envelope.Body, "client_metadata"), &fields)
	first := func(values ...any) string {
		for _, value := range values {
			if text, _ := value.(string); strings.TrimSpace(text) != "" && len(text) <= 256 {
				return strings.TrimSpace(text)
			}
		}
		return ""
	}
	thread := first(turn["thread_id"], d.inboundHeader("thread-id"), fields.ClientMetadata["thread_id"])
	turnID := first(turn["turn_id"], d.inboundHeader("x-client-turn-id"), d.inboundHeader("x-codex-turn-id"), fields.ClientMetadata["turn_id"])
	if thread == "" || turnID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("client-turn\x00" + d.envelope.ClientScope + "\x00" + thread + "\x00" + turnID))
	return hex.EncodeToString(sum[:])
}

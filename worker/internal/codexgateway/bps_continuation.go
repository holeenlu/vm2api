package codexgateway

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/tidwall/gjson"
)

// BPS 续接（对齐 sub2api openai_excel_bps_continuation.go）：BPS 是 store=false 的完整历史协议，上游不认识
// previous_response_id。Worker 在 BPS 响应完整交付后按 response id 保存一份快照（本轮完整输入 + 交付给调用方的
// 输出项），下一轮带 previous_response_id 时把快照展开为完整历史，并钉住产生该响应的账号（密文只在原账号有效）。
//   - 快照按调用方范围隔离，2 小时过期，与工具回放共用 BPS 状态存储（配置凭据包密钥时加密落盘，单条与合计有上限）；
//   - 查不到快照时不猜测：交给原有续接逻辑（原生 WS 续接 / 控制面展开 / previous_response_not_found）。
const (
	bpsContinuationVersion  = 1
	bpsContinuationTTL      = 2 * time.Hour
	bpsContinuationMaxItems = 8192
	bpsContinuationMaxBytes = 12 << 20
	// bpsContinuationPendingWait：上一轮已交付终态、快照还在保存时，下一轮续接最多等这么久（对齐 sub2api）
	bpsContinuationPendingWait = time.Second
)

type bpsContinuationSnapshot struct {
	Version   int               `json:"version"`
	Account   string            `json:"account"`
	Revision  int64             `json:"revision"`
	CreatedAt time.Time         `json:"created_at"`
	Input     []json.RawMessage `json:"input"`
	Output    []json.RawMessage `json:"output"`
	// Tools 是产生该响应的请求声明的工具；续接请求没带 tools 时补回（对齐 sub2api）
	Tools json.RawMessage `json:"tools,omitempty"`
}

func bpsPendingKey(clientScope, responseID string) string { return clientScope + "\x00" + responseID }

// markBPSContinuationPending 登记一个正在交付的 BPS 响应；返回的函数在快照保存完（或交付结束）时调用，解除登记。
func (s *Server) markBPSContinuationPending(clientScope, responseID string) func() {
	if s.bps.disk == nil || clientScope == "" || responseID == "" {
		return func() {}
	}
	key := bpsPendingKey(clientScope, responseID)
	done := make(chan struct{})
	s.bps.pendingMu.Lock()
	if s.bps.pending == nil {
		s.bps.pending = map[string]chan struct{}{}
	}
	s.bps.pending[key] = done
	s.bps.pendingMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.bps.pendingMu.Lock()
			if s.bps.pending[key] == done {
				delete(s.bps.pending, key)
			}
			s.bps.pendingMu.Unlock()
			close(done)
		})
	}
}

// awaitBPSContinuationPending 在该响应仍在保存快照时等待（最多 bpsContinuationPendingWait）；没有登记时立即返回 false。
func (s *Server) awaitBPSContinuationPending(clientScope, responseID string) bool {
	s.bps.pendingMu.Lock()
	done, ok := s.bps.pending[bpsPendingKey(clientScope, responseID)]
	s.bps.pendingMu.Unlock()
	if !ok {
		return false
	}
	timer := time.NewTimer(bpsContinuationPendingWait)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// bpsHasCompaction：请求输入或响应输出含 compaction 项。压缩轮的输出替代了之前的历史，不能当作“输入 + 输出”拼接
func bpsHasCompaction(items []json.RawMessage) bool {
	for _, item := range items {
		switch gjson.GetBytes(item, "type").String() {
		case "compaction", "compaction_trigger":
			return true
		}
	}
	return false
}

func bpsContinuationScope(clientScope string) string { return "continuation:v1/key:" + clientScope }

// requestInputItems 把请求 input（字符串或数组）规范为输入项数组。
func requestInputItems(body []byte) ([]json.RawMessage, bool) {
	input := gjson.GetBytes(body, "input")
	switch {
	case !input.Exists():
		return nil, true
	case input.Type == gjson.String:
		item, _ := json.Marshal(map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": input.String()}}})
		return []json.RawMessage{item}, true
	case input.IsArray():
		var items []json.RawMessage
		ok := true
		input.ForEach(func(_, value gjson.Result) bool {
			if !value.IsObject() || len(items) >= bpsContinuationMaxItems {
				ok = false
				return false
			}
			items = append(items, json.RawMessage(value.Raw))
			return true
		})
		return items, ok
	}
	return nil, false
}

// saveBPSContinuation 在 BPS 响应完整交付后保存续接快照；输出未完整观测到或超出上限时不保存（下一轮按原逻辑处理）。
func (s *Server) saveBPSContinuation(d *dispatchRun, account Account, observer *sseObserver) {
	if s.bps.disk == nil || observer.responseID == "" || account.BPS == nil || d.envelope.ClientScope == "" {
		return
	}
	output := observer.outputItems()
	input, ok := requestInputItems(d.body)
	if !ok || len(output) == 0 || len(input)+len(output) > bpsContinuationMaxItems || bpsHasCompaction(input) || bpsHasCompaction(output) {
		return
	}
	snapshot := bpsContinuationSnapshot{Version: bpsContinuationVersion, Account: account.ID, Revision: account.BPS.Revision, CreatedAt: time.Now().UTC(), Input: input, Output: output}
	if tools := gjson.GetBytes(d.body, "tools"); tools.IsArray() {
		snapshot.Tools = json.RawMessage(tools.Raw)
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = s.bps.disk.SaveBPSState(ctx, bpsContinuationScope(d.envelope.ClientScope), "resp:"+observer.responseID, nil, raw)
}

// expandBPSContinuation 把 previous_response_id 指向的 BPS 快照展开为完整历史并钉住原账号；没有快照时返回 false。
func (s *Server) expandBPSContinuation(run *dispatchRun, previousID string) bool {
	if s.bps.disk == nil || run.envelope.ClientScope == "" || strings.TrimSpace(previousID) == "" {
		return false
	}
	load := func() ([]byte, error) {
		raw, _, err := s.bps.disk.LoadBPSState(context.Background(), bpsContinuationScope(run.envelope.ClientScope), "resp:"+previousID)
		return raw, err
	}
	raw, err := load()
	// 上一轮刚交付终态、快照仍在保存：等它保存完再读（对齐 sub2api 的 pending 快照）
	if err == nil && len(raw) == 0 && s.awaitBPSContinuationPending(run.envelope.ClientScope, previousID) {
		raw, err = load()
	}
	if err != nil || len(raw) == 0 {
		return false
	}
	var snapshot bpsContinuationSnapshot
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Version != bpsContinuationVersion || snapshot.Account == "" || time.Since(snapshot.CreatedAt) > bpsContinuationTTL {
		return false
	}
	if pinned := run.envelope.Scope.RuntimeAccountID; pinned != "" && pinned != snapshot.Account {
		return false
	}
	// 快照属于产生它的那份 BPS 授权：之后重新授权或撤销，快照里的回放与密文不再可用（对齐 sub2api 授权身份校验）
	if owner, ok := s.store.Get(snapshot.Account); !ok || owner.BPS == nil || owner.BPS.Revision != snapshot.Revision {
		return false
	}
	current, ok := requestInputItems(run.body)
	if !ok {
		return false
	}
	items := make([]json.RawMessage, 0, len(snapshot.Input)+len(snapshot.Output)+len(current))
	items = append(append(append(items, snapshot.Input...), snapshot.Output...), current...)
	if len(items) > bpsContinuationMaxItems {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(run.body, &fields) != nil {
		return false
	}
	joined, err := json.Marshal(items)
	if err != nil {
		return false
	}
	fields["input"] = joined
	delete(fields, "previous_response_id")
	if _, declared := fields["tools"]; !declared && len(snapshot.Tools) > 0 {
		fields["tools"] = snapshot.Tools
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return false
	}
	run.body = body
	run.bpsContinued = true
	run.envelope.Scope.RuntimeAccountID = snapshot.Account
	return true
}

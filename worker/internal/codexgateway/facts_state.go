package codexgateway

import (
	"context"
	"log"
	"sort"
)

// 事实直读的运行状态（设计第 19 节）：同机 Worker 以只读方式直读控制面数据库，把账号事实合并进账号表
// （facts_apply.go），配置、分组与凭据以库为准。G4 起这是唯一的账号来源，控制面不再推送投影。

type factsState struct {
	reader *FactsReader
}

// startFacts 在配置了事实库时启动读取器；每次读到变化就合并进账号表。
func (s *Server) startFacts(ctx context.Context) {
	if s.facts == nil {
		return
	}
	s.facts.reader.onChange = func(facts map[string]AccountFacts) {
		// 等待中的选号每 250ms 复查一次，合并后的变化随之生效
		if _, err := s.store.ApplyFacts(facts); err != nil {
			log.Printf("codex-gateway: applying facts failed: %v", err)
		}
	}
	go s.facts.reader.Run(ctx)
	// 未能写回的刷新结果定期补写（facts_write.go）
	go s.credentialSyncLoop(ctx)
}

// factsStatus 是健康接口与心跳里的 facts 字段；未启用时为 nil。读取出错的账号随 errors 上报，控制面据此标记绑定。
func (s *Server) factsStatus() map[string]any {
	if s.facts == nil {
		return nil
	}
	facts, status := s.facts.reader.Snapshot()
	// 上报全部读取出错的账号（按 ID 排序，上限 1000）：控制面据此把它们标为同步异常，列表不完整时不会误标其余账号
	ids := make([]string, 0)
	for id, fact := range facts {
		if len(fact.Errors) > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	errored := make([]map[string]any, 0, min(len(ids), 1000))
	for _, id := range ids {
		if len(errored) >= 1000 {
			break
		}
		errored = append(errored, map[string]any{"account": id, "fields": facts[id].Errors})
	}
	return map[string]any{"mode": "primary", "status": status, "fact_errors": errored}
}

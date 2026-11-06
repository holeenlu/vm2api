package codexgateway

import (
	"context"
	"log"
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
}

// factsStatus 是健康接口与心跳里的 facts 字段；未启用时为 nil。读取出错的账号随 errors 上报，控制面据此标记绑定。
func (s *Server) factsStatus() map[string]any {
	if s.facts == nil {
		return nil
	}
	facts, status := s.facts.reader.Snapshot()
	errored := []map[string]any{}
	for id, fact := range facts {
		if len(fact.Errors) > 0 && len(errored) < 20 {
			errored = append(errored, map[string]any{"account": id, "fields": fact.Errors})
		}
	}
	return map[string]any{"mode": "primary", "status": status, "fact_errors": errored}
}

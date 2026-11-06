package codexgateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// 上游 Codex 模型目录（对齐 codex-proxy-rs 模型目录合同）：按账号 ID 排序最多尝试 3 个可用 OAuth 账号，
// 成功结果按 client_version 缓存 5 分钟；全部失败返回 503 model_catalog_unavailable，不用空列表覆盖。
const (
	catalogAccountAttempts = 3
	catalogCacheTTL        = 5 * time.Minute
	catalogRequestTimeout  = 20 * time.Second
)

type catalogEntry struct {
	body    json.RawMessage
	fetched time.Time
}

type catalogCache struct {
	mu      sync.Mutex
	entries map[string]catalogEntry
	// etag 是推理响应最近声明的目录版本（x-models-etag）；refreshing 防止重复触发套餐目录刷新
	etag       string
	refreshing bool
}

const maxModelsETagBytes = 256

// observeModelsETag：推理响应声明了新的目录版本时，清空客户端目录缓存并立即刷新套餐目录（CPR observe_response_etag）。
// 同一版本只触发一次。
func (s *Server) observeModelsETag(etag string) {
	etag = strings.TrimSpace(etag)
	if etag == "" || len(etag) > maxModelsETagBytes || !validHeaderValue(etag) {
		return
	}
	s.catalog.mu.Lock()
	if s.catalog.etag == etag {
		s.catalog.mu.Unlock()
		return
	}
	s.catalog.etag = etag
	s.catalog.entries = map[string]catalogEntry{}
	start := !s.catalog.refreshing
	s.catalog.refreshing = true
	s.catalog.mu.Unlock()
	if !start {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		s.refreshPlanCatalogs(ctx, time.Now())
		s.catalog.mu.Lock()
		s.catalog.refreshing = false
		s.catalog.mu.Unlock()
	}()
}

// catalogCacheKey：客户端版本与画像身份（originator、UA）都相同才复用目录
func (s *Server) catalogCacheKey(clientVersion string) string {
	profile := s.globalProfile()
	return clientVersion + "\x00" + profile.Originator + "\x00" + profile.userAgent()
}

func (s *Server) models(w http.ResponseWriter, r *http.Request) {
	clientVersion := strings.TrimSpace(r.URL.Query().Get("client_version"))
	if clientVersion == "" {
		var body struct {
			ClientVersion string `json:"client_version"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body)
		clientVersion = strings.TrimSpace(body.ClientVersion)
	}
	if clientVersion == "" {
		clientVersion = s.globalProfile().CodexVersion
	}
	cacheKey := s.catalogCacheKey(clientVersion)
	s.catalog.mu.Lock()
	if entry, ok := s.catalog.entries[cacheKey]; ok && time.Since(entry.fetched) < catalogCacheTTL {
		s.catalog.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "client_version": clientVersion, "cached": true, "catalog": entry.body})
		return
	}
	s.catalog.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), catalogRequestTimeout*catalogAccountAttempts)
	defer cancel()
	body, err := s.fetchCatalog(ctx, clientVersion)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "model_catalog_unavailable", err.Error())
		return
	}
	s.catalog.mu.Lock()
	s.catalog.entries[cacheKey] = catalogEntry{body: body, fetched: time.Now()}
	s.catalog.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "client_version": clientVersion, "catalog": body})
}

func (s *Server) fetchCatalog(ctx context.Context, clientVersion string) (json.RawMessage, error) {
	now := time.Now()
	var candidates []Account
	for _, account := range s.store.snapshot() {
		if account.Enabled && !account.Paused && account.APIKey == "" && credentialUsable(account, now) {
			candidates = append(candidates, account)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })
	var lastErr error = errNoCatalogAccount
	for i, account := range candidates {
		if i >= catalogAccountAttempts {
			break
		}
		body, err := s.fetchCatalogWith(ctx, account, clientVersion)
		if err == nil {
			return body, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

var errNoCatalogAccount = &catalogError{"no eligible OAuth account for the model catalog"}

type catalogError struct{ message string }

func (e *catalogError) Error() string { return e.message }

func (s *Server) fetchCatalogWith(ctx context.Context, account Account, clientVersion string) (json.RawMessage, error) {
	requestCtx, cancel := context.WithTimeout(ctx, catalogRequestTimeout)
	defer cancel()
	target := strings.TrimRight(s.cfg.UpstreamBaseURL, "/") + "/models?client_version=" + url.QueryEscape(clientVersion)
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	// 目录接口校验 originator、User-Agent 前缀与 version 一致，按请求的客户端版本发送
	applyProfileIdentity(req.Header, account, s.globalProfile().withCoreVersion(clientVersion))
	client, err := s.clientFor(account)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	// 目录接口的失败不改变账号事实（CPR 只由推理与额度 402 判定账号状态），换下一个账号读取
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &catalogError{"model catalog returned " + http.StatusText(resp.StatusCode)}
	}
	var probe struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(data, &probe) != nil || len(probe.Models) == 0 {
		return nil, &catalogError{"empty model catalog"}
	}
	return data, nil
}

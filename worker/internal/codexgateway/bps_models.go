package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BPS 模型目录（对齐 sub2api openai_excel_bps_model_access.go）：GET {BPS}/responses/access?include_models=true
// 返回账号可用的模型、受限模型与推理强度。只采用官方返回：allowed=false 或空目录是权威结果；
// HTTP 失败或格式错误不会产生本地允许名单。目录按账号与授权代次缓存 10 分钟，过期不回退旧值。
var bpsModelID = regexp.MustCompile(`^gpt-[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

const bpsModelCatalogTTL = 10 * time.Minute

type bpsCatalogModel struct {
	ID               string   `json:"id"`
	DisplayName      string   `json:"display_name,omitempty"`
	ReasoningEfforts []string `json:"reasoning_efforts"`
	// CoolingDown：该账号最近被拒绝此模型（模型无权冷却中），目录可见但当前不会选中
	CoolingDown bool `json:"cooling_down,omitempty"`
}

type bpsModelCatalog struct {
	Allowed    bool              `json:"allowed"`
	Models     []bpsCatalogModel `json:"models"`
	Restricted []string          `json:"restricted_models"`
	FetchedAt  time.Time         `json:"fetched_at"`
}

type bpsCatalogCache struct {
	mu      sync.Mutex
	entries map[string]bpsModelCatalog
}

func parseBPSAccess(raw []byte) (bpsModelCatalog, error) {
	var envelope struct {
		Allowed *bool `json:"allowed"`
		Catalog *struct {
			Models     *[]json.RawMessage `json:"models"`
			Restricted []string           `json:"restricted_models"`
		} `json:"model_catalog"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Allowed == nil {
		return bpsModelCatalog{}, errors.New("invalid BPS access response")
	}
	catalog := bpsModelCatalog{Allowed: *envelope.Allowed, Models: []bpsCatalogModel{}, Restricted: []string{}}
	if !catalog.Allowed {
		return catalog, nil
	}
	if envelope.Catalog == nil || envelope.Catalog.Models == nil {
		return bpsModelCatalog{}, errors.New("missing BPS model catalog")
	}
	restricted := map[string]bool{}
	for _, id := range envelope.Catalog.Restricted {
		restricted[id] = true
		catalog.Restricted = append(catalog.Restricted, id)
	}
	seen := map[string]bool{}
	for _, raw := range *envelope.Catalog.Models {
		var entry struct {
			ID        string `json:"id"`
			Label     string `json:"label"`
			Available *bool  `json:"available"`
			Enabled   *bool  `json:"enabled"`
			Picker    *bool  `json:"model_picker_enabled"`
			Policy    *struct {
				State string `json:"state"`
			} `json:"policy"`
			Efforts []struct {
				Value string `json:"value"`
			} `json:"efforts"`
		}
		if json.Unmarshal(raw, &entry) != nil || !bpsModelID.MatchString(entry.ID) || restricted[entry.ID] || seen[entry.ID] {
			continue
		}
		if entry.Available != nil && !*entry.Available || entry.Enabled != nil && !*entry.Enabled || entry.Picker != nil && !*entry.Picker || entry.Policy != nil && (entry.Policy.State == "disabled" || entry.Policy.State == "unconfigured") {
			continue
		}
		model := bpsCatalogModel{ID: entry.ID, DisplayName: strings.TrimSpace(entry.Label), ReasoningEfforts: []string{}}
		effortSeen := map[string]bool{}
		for _, effort := range entry.Efforts {
			switch effort.Value {
			case "low", "medium", "high", "xhigh":
				if !effortSeen[effort.Value] {
					model.ReasoningEfforts = append(model.ReasoningEfforts, effort.Value)
					effortSeen[effort.Value] = true
				}
			}
		}
		catalog.Models = append(catalog.Models, model)
		seen[entry.ID] = true
	}
	return catalog, nil
}

func (s *Server) bpsModelCatalog(ctx context.Context, account Account, refresh bool) (bpsModelCatalog, error) {
	if account.BPS == nil || account.BPS.AccessToken == "" {
		return bpsModelCatalog{}, errBPSNotAuthorized
	}
	key := fmt.Sprintf("%s/%d", account.ID, account.BPS.Revision)
	now := time.Now()
	s.bps.catalogs.mu.Lock()
	cached, ok := s.bps.catalogs.entries[key]
	s.bps.catalogs.mu.Unlock()
	if !ok || refresh || now.Sub(cached.FetchedAt) > bpsModelCatalogTTL {
		client, err := s.clientFor(account)
		if err != nil {
			return bpsModelCatalog{}, err
		}
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.bpsURL("/responses/access")+"?include_models=true", nil)
		if err != nil {
			return bpsModelCatalog{}, err
		}
		setBPSHeaders(req.Header, account, "application/json")
		req.Header.Del("Content-Type")
		resp, err := client.Do(req)
		if err != nil {
			return bpsModelCatalog{}, fmt.Errorf("BPS model discovery request failed: %w", err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if err != nil {
			return bpsModelCatalog{}, err
		}
		if resp.StatusCode != http.StatusOK {
			return bpsModelCatalog{}, fmt.Errorf("BPS model discovery returned HTTP %d", resp.StatusCode)
		}
		if cached, err = parseBPSAccess(raw); err != nil {
			return bpsModelCatalog{}, err
		}
		cached.FetchedAt = now.UTC()
		s.bps.catalogs.mu.Lock()
		if s.bps.catalogs.entries == nil {
			s.bps.catalogs.entries = map[string]bpsModelCatalog{}
		}
		s.bps.catalogs.entries[key] = cached
		s.bps.catalogs.mu.Unlock()
	}
	// 目录不是推理许可的证明：叠加该账号的模型无权冷却
	models := make([]bpsCatalogModel, len(cached.Models))
	for i, model := range cached.Models {
		if until, ok := account.BPS.ModelCooldowns[model.ID]; ok && until.After(now) {
			model.CoolingDown = true
		}
		models[i] = model
	}
	cached.Models = models
	return cached, nil
}

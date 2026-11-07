package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
)

// bpsRefreshTerminalCodes 是刷新令牌已失效、只能重新授权的错误码。
var bpsRefreshTerminalCodes = map[string]bool{
	"invalid_grant": true, "token_revoked": true, "grant_revoked": true, "token_invalidated": true,
	"refresh_token_expired": true, "refresh_token_reused": true, "refresh_token_invalidated": true,
}

// accountBPSAction 处理 /internal/v1/accounts/{id}/bps[/models|/unblock|/recovery/stop]：查询模型目录、手动解除与停止恢复、
// 撤销本地授权（DELETE；控制面撤销以库为准，Worker 读到后同样删除）。BPS 授权的写入由控制面完成（S1）。
func (s *Server) accountBPSAction(w http.ResponseWriter, r *http.Request, accountID string, parts []string) bool {
	if len(parts) < 2 || parts[1] != "bps" {
		return false
	}
	switch {
	case len(parts) == 3 && parts[2] == "unblock" && r.Method == http.MethodPost:
		// 运营手动解除：清除 403 停用、恢复探测状态与全部 BPS 冷却（不改授权令牌）
		saved, err := s.store.UpdateBPS(accountID, func(account *Account) bool {
			grant := account.BPS
			if grant == nil {
				return false
			}
			if grant.State == bpsStateBlocked {
				grant.State = ""
			}
			grant.BlockedAt, grant.ProbedAt, grant.RecoveryStopped, grant.LastError = time.Time{}, time.Time{}, false, ""
			grant.CooldownUntil, grant.ScopedCooldowns, grant.PolicyBackoff, grant.ModelCooldowns = time.Time{}, nil, nil, nil
			return true
		})
		if err != nil {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(saved)})
	case len(parts) == 4 && parts[2] == "recovery" && parts[3] == "stop" && r.Method == http.MethodPost:
		saved, err := s.store.UpdateBPS(accountID, func(account *Account) bool {
			if account.BPS == nil || account.BPS.State != bpsStateBlocked || account.BPS.RecoveryStopped {
				return false
			}
			account.BPS.RecoveryStopped = true
			return true
		})
		if err != nil {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(saved)})
	case len(parts) == 3 && parts[2] == "models" && r.Method == http.MethodGet:
		account, ok := s.store.Get(accountID)
		if !ok {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return true
		}
		catalog, err := s.bpsModelCatalog(r.Context(), account, r.URL.Query().Get("refresh") == "1")
		if errors.Is(err, errBPSNotAuthorized) {
			writeError(w, http.StatusConflict, "bps_not_authorized", err.Error())
			return true
		}
		if err != nil {
			writeError(w, http.StatusBadGateway, "bps_models_unavailable", err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, catalog)
	case len(parts) == 2 && r.Method == http.MethodDelete:
		saved, err := s.store.UpdateBPS(accountID, func(account *Account) bool {
			if account.BPS == nil {
				return false
			}
			account.BPS = nil
			return true
		})
		if err != nil {
			writeError(w, http.StatusNotFound, "account_not_found", "account not found")
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": publicAccount(saved)})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "unsupported BPS action")
	}
	return true
}

// bpsRefreshDue：BPS 授权有刷新令牌、状态可用，且 AT 已过期或进入提前刷新窗口。
func bpsRefreshDue(grant *BPSGrant, now time.Time) bool {
	if grant == nil || grant.RefreshToken == "" || (grant.State != "" && grant.State != bpsStateBlocked) || grant.ExpiresAt.IsZero() {
		return false
	}
	return grant.ExpiresAt.Sub(now) <= refreshMargin
}

// refreshBPS 用 Excel 客户端刷新账号的 BPS 授权（表单正文带 scope，与 sub2api Excel 刷新一致）；
// 刷新令牌被拒时 BPS 判 invalid，需要重新授权，原生授权不受影响。
// refreshBPS 刷新 BPS 授权并把结果写回凭据库（调用方持有 s.bps.refreshMu 或在后台循环内串行调用）。
func (s *Server) refreshBPS(ctx context.Context, accountID string) error {
	if err := s.doRefreshBPS(ctx, accountID); err != nil {
		return err
	}
	s.syncCredentials(ctx, accountID)
	return nil
}

// doRefreshBPS 用 BPS 刷新令牌换票。
func (s *Server) doRefreshBPS(ctx context.Context, accountID string) error {
	account, ok := s.store.Get(accountID)
	if !ok || account.BPS == nil || account.BPS.RefreshToken == "" {
		return errBPSNotAuthorized
	}
	revision, generation := account.BPS.Revision, account.BPS.TokenGeneration
	form := url.Values{"client_id": {s.cfg.BPSClientID}, "grant_type": {"refresh_token"}, "refresh_token": {account.BPS.RefreshToken}, "scope": {bpsRefreshScope}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.OAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client, err := s.clientFor(account)
	if err != nil {
		return err
	}
	req, wrote := traceWritten(req)
	resp, err := client.Do(req)
	if err != nil {
		return sentButUnanswered(wrote, err)
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, refreshResponseMaxSize))
	if readErr != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return fmt.Errorf("%w: %v", errRefreshAmbiguous, readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 只有 400/401 且带明确的刷新令牌失效码才判 invalid（对齐 sub2api excelRefreshRejection，
		// 另含原生刷新的 refresh_token_* 终态码）；其他失败保留授权，下次再试
		code, _ := oauthErrorCode(data)
		terminal := (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized) && bpsRefreshTerminalCodes[code]
		_, _ = s.store.UpdateBPS(accountID, func(account *Account) bool {
			// 期间重新授权或投影送来更新的令牌（授权代次或令牌代次变化）：这次失败属于旧令牌，不改状态
			if account.BPS == nil || account.BPS.Revision != revision || account.BPS.TokenGeneration != generation {
				return false
			}
			account.BPS.LastError = fmt.Sprintf("refresh_%d", resp.StatusCode)
			if terminal {
				account.BPS.State = bpsStateInvalid
				account.BPS.LastError = code
			}
			return true
		})
		return fmt.Errorf("BPS refresh returned %d", resp.StatusCode)
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(data, &token); err != nil || token.AccessToken == "" {
		return errors.New("invalid BPS refresh response")
	}
	_, err = s.store.UpdateBPS(accountID, func(account *Account) bool {
		grant := account.BPS
		// 授权代次与令牌代次都未变才写回：期间投影送来更新的令牌时不覆盖（R3 复审 N6）
		if grant == nil || grant.Revision != revision || grant.TokenGeneration != generation {
			return false
		}
		grant.AccessToken = token.AccessToken
		if token.RefreshToken != "" {
			grant.RefreshToken = token.RefreshToken
		}
		if token.IDToken != "" {
			grant.IDToken = token.IDToken
		}
		grant.ExpiresAt = time.Time{}
		if exp, ok := jwtClaims(token.AccessToken)["exp"].(float64); ok && exp > 0 {
			grant.ExpiresAt = time.Unix(int64(exp), 0).UTC()
		} else if token.ExpiresIn > 0 {
			grant.ExpiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second).UTC()
		}
		if grant.State == bpsStateExpired {
			grant.State = ""
		}
		grant.RefreshedAfterRejection, grant.AccessRejected = grant.AccessRejected, false
		grant.LastError = ""
		grant.TokenGeneration++
		return true
	})
	return err
}

func (s *Server) refreshDueBPS(ctx context.Context, now time.Time) {
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return
		}
		if bpsRefreshDue(account.BPS, now) {
			// 与请求内 401 刷新共用同一把锁，同一实例内不会并发使用同一个 BPS 刷新令牌；
			// 单次换票有截止时间，不超过刷新租约的 60 秒（R3 审查 P2-3）
			s.bps.refreshMu.Lock()
			if current, ok := s.store.Get(account.ID); ok && bpsRefreshDue(current.BPS, now) {
				refreshCtx, cancel := context.WithTimeout(ctx, refreshRequestTimeout)
				_ = s.refreshBPS(refreshCtx, account.ID)
				cancel()
			}
			s.bps.refreshMu.Unlock()
		}
	}
}

// probeBlockedBPS 对 403 停用且开启自动恢复的启用账号，按间隔用名单中第一个文本模型（bpsProbeModel）发一次极小的 BPS 请求探测；
// 成功即恢复 BPS（sub2api openai_excel_bps_recovery.go）。探测消耗不进入使用记录。
func (s *Server) probeBlockedBPS(ctx context.Context, now time.Time) {
	if s.bpsBackgroundOff.Load() {
		return
	}
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return
		}
		grant, settings := account.BPS, account.BPSSettings
		// 停用或暂停的账号不调度，也不探测（对齐 sub2api 只探测启用且可调度的账号）
		if !account.Enabled || account.Paused || grant == nil || grant.State != bpsStateBlocked || grant.RecoveryStopped || settings == nil || !settings.AutoRecoverOn403 {
			continue
		}
		model := bpsProbeModel(settings.Models)
		if model == "" {
			continue
		}
		last := grant.ProbedAt
		if last.IsZero() {
			last = grant.BlockedAt
		}
		if now.Sub(last) < settings.recoveryInterval() {
			continue
		}
		ok := s.probeBPS(ctx, account, model)
		_, _ = s.store.UpdateBPS(account.ID, func(current *Account) bool {
			if current.BPS == nil || current.BPS.Revision != grant.Revision || current.BPS.State != bpsStateBlocked {
				return false
			}
			current.BPS.ProbedAt = now
			if ok {
				current.BPS.State, current.BPS.BlockedAt, current.BPS.LastError = "", time.Time{}, ""
			}
			return true
		})
	}
}

// bpsProbeModel 取名单中第一个文本模型做恢复探测（对齐 sub2api）：探测发的是 Responses 请求，图片模型
// （gpt-image-*）走不了，只勾了图片模型的账号不探测。
func bpsProbeModel(models []string) string {
	for _, model := range models {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "gpt-image-") {
			return model
		}
	}
	return ""
}

// recoverBPSModels 按恢复间隔复核模型无权冷却（对齐 codex2api 原作者：模型级暂停以 access 目录重新列出该模型为恢复依据）：
// 目录允许且列出被冷却的模型时提前解除；目录不可用或仍未列出时保留原到期时间（30 分钟兜底不变）。只读目录，不发生成请求。
func (s *Server) recoverBPSModels(ctx context.Context, now time.Time) {
	if s.bpsBackgroundOff.Load() {
		return
	}
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return
		}
		grant := account.BPS
		if grant == nil || grant.State != "" || grant.AccessToken == "" || !hasActiveCooldown(grant.ModelCooldowns, now) {
			continue
		}
		if now.Sub(grant.ModelsProbedAt) < account.BPSSettings.recoveryInterval() {
			continue
		}
		catalog, err := s.bpsModelCatalog(ctx, account, true)
		listed := map[string]bool{}
		if err == nil && catalog.Allowed {
			for _, model := range catalog.Models {
				listed[model.ID] = true
			}
		}
		_, _ = s.store.UpdateBPS(account.ID, func(current *Account) bool {
			if current.BPS == nil || current.BPS.Revision != grant.Revision {
				return false
			}
			current.BPS.ModelsProbedAt = now
			for model := range current.BPS.ModelCooldowns {
				if listed[model] {
					delete(current.BPS.ModelCooldowns, model)
				}
			}
			return true
		})
	}
}

func hasActiveCooldown(cooldowns map[string]time.Time, now time.Time) bool {
	for _, until := range cooldowns {
		if until.After(now) {
			return true
		}
	}
	return false
}

// probeBPS 用名单中第一个模型发一次极小的 BPS 请求，并把结果与用量记入待上报的探测记录。
func (s *Server) probeBPS(ctx context.Context, account Account, model string) bool {
	started := time.Now()
	record := bpsProbeRecord{AccountID: account.ID, ProbedAt: started.UTC(), Model: model}
	defer func() {
		record.DurationMS = time.Since(started).Milliseconds()
		s.recordBPSProbe(record)
	}()
	raw, _ := json.Marshal(map[string]any{"model": model, "stream": true, "input": []any{map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "ping"}}}}})
	body, _, err := basispoints.Prepare(raw, "", nil)
	if err != nil {
		record.ErrorCode = "probe_prepare_failed"
		return false
	}
	client, err := s.clientFor(account)
	if err != nil {
		record.ErrorCode = "probe_transport_unavailable"
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	resp, _, err := s.postBPS(ctx, client, account, body)
	if err != nil {
		record.ErrorCode = "probe_transport_error"
		return false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	record.Status = resp.StatusCode
	usage, code := bpsProbeUsage(data)
	record.InputTokens, record.OutputTokens, record.TotalTokens = usageInt(usage, "input_tokens"), usageInt(usage, "output_tokens"), usageInt(usage, "total_tokens")
	if record.TotalTokens == 0 {
		record.TotalTokens = record.InputTokens + record.OutputTokens
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 记录上游声明的错误码（协议包会把未知码归为通用码）
		code = firstString(parseUpstreamError(data).code, fmt.Sprintf("http_%d", resp.StatusCode))
	}
	record.ErrorCode = code
	record.OK = resp.StatusCode >= 200 && resp.StatusCode < 300 && code == ""
	return record.OK
}

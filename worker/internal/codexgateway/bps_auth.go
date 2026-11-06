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

// grantBPS 是 OAuth 会话的授权类型：Excel（Basispoints）附加授权。
const grantBPS = "bps"

var (
	errBPSNeedsNativeAuthorization = errors.New("BPS authorization requires an account that has completed OAuth")
	errBPSIdentityMismatch         = errors.New("BPS authorization belongs to a different ChatGPT account")
)

// bpsTokens 是一次 Excel 授权（换码或导入）得到的令牌与身份。
type bpsTokens struct {
	AccessToken      string
	RefreshToken     string
	IDToken          string
	ExpiresAt        int64
	ChatGPTAccountID string
}

// saveBPSGrant 把 Excel 授权写入已有 OAuth 账号：身份须与原生授权同一 ChatGPT 账号；
// expected ≥ 0 时按 BPS 授权代次做 CAS。新授权清除 BPS 的失效、冷却与 403 停用状态。
// saveBPSGrant 写入新的 BPS 授权。minGeneration 是控制面给出的令牌代次下限（凭据库、租约表里已知的最大值）：
// 新令牌代次取 max(本地, 下限) + 1，避免本实例副本落后时与其他实例刷新出的代次撞号（R3 复审 N2）。
func (s *Server) saveBPSGrant(accountID string, tokens bpsTokens, expected int64, minGeneration int64) (map[string]any, error) {
	if tokens.AccessToken == "" {
		return nil, errors.New("BPS authorization is missing access_token")
	}
	var conflict error
	saved, err := s.store.UpdateBPS(accountID, func(account *Account) bool {
		if account.AccessToken == "" {
			conflict = errBPSNeedsNativeAuthorization
			return false
		}
		if account.ChatGPTAccountID != "" && tokens.ChatGPTAccountID != "" && account.ChatGPTAccountID != tokens.ChatGPTAccountID {
			conflict = errBPSIdentityMismatch
			return false
		}
		revision, generation := int64(0), int64(0)
		if account.BPS != nil {
			revision, generation = account.BPS.Revision, account.BPS.TokenGeneration
		}
		if expected >= 0 && expected != revision {
			conflict = fmt.Errorf("BPS revision conflict: expected %d, got %d", expected, revision)
			return false
		}
		grant := &BPSGrant{AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken, IDToken: tokens.IDToken, Revision: revision + 1, TokenGeneration: max(generation, minGeneration) + 1}
		if tokens.ExpiresAt > 0 {
			grant.ExpiresAt = time.Unix(tokens.ExpiresAt, 0).UTC()
		} else if exp, ok := jwtClaims(tokens.AccessToken)["exp"].(float64); ok && exp > 0 {
			grant.ExpiresAt = time.Unix(int64(exp), 0).UTC()
		}
		account.BPS = grant
		return true
	})
	if err != nil {
		return nil, err
	}
	if conflict != nil {
		return nil, conflict
	}
	return map[string]any{"ok": true, "gateway_instance_id": s.cfg.InstanceID, "account": publicAccount(saved), "bps_revision": saved.BPS.Revision}, nil
}

// validateBPSTokens 校验导入的 Excel 授权：AT 签发给 Excel 客户端（client_id 或 azp），id_token 的 aud 含 Excel 客户端；
// 返回令牌中的 ChatGPT 账号 ID 与套餐（sub2api openai_excel_oauth.go）。
func (s *Server) validateBPSTokens(tokens bpsTokens) (string, string, error) {
	access := jwtClaims(tokens.AccessToken)
	if issued := firstString(access["client_id"], access["azp"]); issued != "" && issued != s.cfg.BPSClientID {
		return "", "", errors.New("BPS authorization was issued to another client")
	}
	identity := jwtClaims(tokens.IDToken)
	if tokens.IDToken != "" && !audienceIncludes(identity["aud"], s.cfg.BPSClientID) {
		return "", "", errors.New("BPS id_token audience does not include the Excel client")
	}
	auth, _ := identity["https://api.openai.com/auth"].(map[string]any)
	accessAuth, _ := access["https://api.openai.com/auth"].(map[string]any)
	accountID := firstString(tokens.ChatGPTAccountID, auth["chatgpt_account_id"], accessAuth["chatgpt_account_id"])
	plan := firstString(auth["chatgpt_plan_type"], accessAuth["chatgpt_plan_type"])
	if strings.EqualFold(plan, "free") {
		return "", "", errors.New("BPS requires a paid ChatGPT plan")
	}
	return accountID, plan, nil
}

func audienceIncludes(value any, client string) bool {
	switch aud := value.(type) {
	case nil:
		return true
	case string:
		return aud == client
	case []any:
		for _, item := range aud {
			if item == client {
				return true
			}
		}
	}
	return false
}

// accountBPSAction 处理 /internal/v1/accounts/{id}/bps[/import|/models]：导入 Excel 授权（POST import）、查询模型目录（GET models）、撤销（DELETE）。
func (s *Server) accountBPSAction(w http.ResponseWriter, r *http.Request, accountID string, parts []string) bool {
	if len(parts) < 2 || parts[1] != "bps" {
		return false
	}
	switch {
	case len(parts) == 3 && parts[2] == "import" && r.Method == http.MethodPost:
		var body struct {
			AccessToken      string `json:"access_token"`
			RefreshToken     string `json:"refresh_token"`
			IDToken          string `json:"id_token"`
			ExpiresAt        int64  `json:"expires_at"`
			ChatGPTAccountID string `json:"chatgpt_account_id"`
			ExpectedRevision *int64 `json:"expected_bps_revision"`
			MinGeneration    int64  `json:"min_bps_token_generation"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
			return true
		}
		tokens := bpsTokens{AccessToken: body.AccessToken, RefreshToken: body.RefreshToken, IDToken: body.IDToken, ExpiresAt: body.ExpiresAt, ChatGPTAccountID: body.ChatGPTAccountID}
		accountIDClaim, _, err := s.validateBPSTokens(tokens)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bps_authorization_invalid", err.Error())
			return true
		}
		tokens.ChatGPTAccountID = accountIDClaim
		expected := int64(-1)
		if body.ExpectedRevision != nil {
			expected = *body.ExpectedRevision
		}
		result, err := s.saveBPSGrant(accountID, tokens, expected, body.MinGeneration)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errBPSNeedsNativeAuthorization) || strings.Contains(err.Error(), "conflict") {
				status = http.StatusConflict
			}
			writeError(w, status, "bps_authorization_rejected", err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, result)
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
// doRefreshBPS 用 BPS 刷新令牌换票（租约由 refreshBPS 处理，refresh_lease.go）。
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
		terminal := resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized
		_, _ = s.store.UpdateBPS(accountID, func(account *Account) bool {
			if account.BPS == nil || account.BPS.Revision != revision {
				return false
			}
			account.BPS.LastError = fmt.Sprintf("refresh_%d", resp.StatusCode)
			if terminal {
				account.BPS.State = bpsStateInvalid
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
		if bpsRefreshDue(account.BPS, now) && s.scheduledRefreshAllowed(account.ID) {
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

// probeBlockedBPS 对 403 停用且开启自动恢复的账号，按间隔用名单中第一个模型发一次极小的 BPS 请求探测；
// 成功即恢复 BPS（sub2api openai_excel_bps_recovery.go）。探测消耗不进入使用记录。
func (s *Server) probeBlockedBPS(ctx context.Context, now time.Time) {
	for _, account := range s.store.snapshot() {
		if ctx.Err() != nil {
			return
		}
		grant, settings := account.BPS, account.BPSSettings
		if grant == nil || grant.State != bpsStateBlocked || grant.RecoveryStopped || settings == nil || !settings.AutoRecoverOn403 || len(settings.Models) == 0 {
			continue
		}
		last := grant.ProbedAt
		if last.IsZero() {
			last = grant.BlockedAt
		}
		if now.Sub(last) < settings.recoveryInterval() {
			continue
		}
		ok := s.probeBPS(ctx, account, settings.Models[0])
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

// recoverBPSModels 按恢复间隔复核模型无权冷却（对齐 codex2api 原作者：模型级暂停以 access 目录重新列出该模型为恢复依据）：
// 目录允许且列出被冷却的模型时提前解除；目录不可用或仍未列出时保留原到期时间（30 分钟兜底不变）。只读目录，不发生成请求。
func (s *Server) recoverBPSModels(ctx context.Context, now time.Time) {
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

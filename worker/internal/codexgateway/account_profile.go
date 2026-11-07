package codexgateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// 账号个人资料（对齐 codex-proxy-rs profile_statistics.rs、profile_avatar.rs、subscription.rs）：
//   - GET /internal/v1/accounts/{id}/profile：/wham/profiles/me 的昵称、头像地址与累计统计投影；
//   - GET /internal/v1/accounts/{id}/subscription：/backend-api/subscriptions 的订阅周期（失败只返回未知）；
//   - GET /internal/v1/accounts/{id}/avatar?source=：只接受 chatgpt.com Estuary 与 cdn.auth0.com 的头像，
//     Estuary 走账号凭据与代理，Auth0 是公开资源不带账号凭据；正文流式透传，不累积。
const (
	maxProfileBodyBytes      = 1 << 20
	maxSubscriptionBodyBytes = 64 << 10
	subscriptionTimeout      = 5 * time.Second
	avatarHeadersTimeout     = 15 * time.Second
	avatarIdleTimeout        = 30 * time.Second
	officialAvatarOrigin     = "https://chatgpt.com"
	officialAvatarPrefix     = "/backend-api/estuary/public_content/enc/"
	auth0AvatarOrigin        = "https://cdn.auth0.com"
	auth0AvatarPrefix        = "/avatars/"
)

var errAvatarSource = errors.New("profile avatar source is invalid")

func trimmedText(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

type profileWire struct {
	Profile struct {
		DisplayName       *string `json:"display_name"`
		Username          *string `json:"username"`
		ProfilePictureURL *string `json:"profile_picture_url"`
	} `json:"profile"`
	Stats *struct {
		LifetimeTokens               *uint64  `json:"lifetime_tokens"`
		PeakDailyTokens              *uint64  `json:"peak_daily_tokens"`
		LongestRunningTurnSec        *uint64  `json:"longest_running_turn_sec"`
		CurrentStreakDays            *uint64  `json:"current_streak_days"`
		LongestStreakDays            *uint64  `json:"longest_streak_days"`
		FastModeUsagePercentage      *float64 `json:"fast_mode_usage_percentage"`
		MostUsedReasoningEffort      *string  `json:"most_used_reasoning_effort"`
		MostUsedReasoningEffortShare *float64 `json:"most_used_reasoning_effort_percentage"`
		UniqueSkillsUsed             *uint64  `json:"unique_skills_used"`
		TotalSkillsUsed              *uint64  `json:"total_skills_used"`
		TotalThreads                 *uint64  `json:"total_threads"`
		DailyUsageBuckets            []struct {
			StartDate string `json:"start_date"`
			Tokens    uint64 `json:"tokens"`
		} `json:"daily_usage_buckets"`
		TopInvocations []struct {
			Type       string  `json:"type"`
			PluginID   *string `json:"plugin_id"`
			PluginName *string `json:"plugin_name"`
			SkillID    *string `json:"skill_id"`
			SkillName  *string `json:"skill_name"`
			UsageCount *uint64 `json:"usage_count"`
		} `json:"top_invocations"`
	} `json:"stats"`
	Metadata struct {
		StatsError *string `json:"stats_error"`
	} `json:"metadata"`
}

// projectProfile 把上游资料转为稳定的展示字段；任务时长换算为毫秒，日用量按日期升序。
func projectProfile(wire profileWire) map[string]any {
	stats := wire.Stats
	out := map[string]any{
		"display_name":    trimmedText(wire.Profile.DisplayName),
		"username":        trimmedText(wire.Profile.Username),
		"image_url":       trimmedText(wire.Profile.ProfilePictureURL),
		"has_stats_error": trimmedText(wire.Metadata.StatsError) != nil,
	}
	var longest any
	if stats.LongestRunningTurnSec != nil {
		longest = *stats.LongestRunningTurnSec * 1000
	}
	out["summary"] = map[string]any{
		"total_text_tokens":        stats.LifetimeTokens,
		"peak_tokens":              stats.PeakDailyTokens,
		"longest_task_duration_ms": longest,
		"current_streak_days":      stats.CurrentStreakDays,
		"longest_streak_days":      stats.LongestStreakDays,
	}
	if stats.DailyUsageBuckets != nil {
		daily := make([]map[string]any, 0, len(stats.DailyUsageBuckets))
		for _, bucket := range stats.DailyUsageBuckets {
			if _, err := time.Parse("2006-01-02", bucket.StartDate); err != nil {
				continue
			}
			daily = append(daily, map[string]any{"date": bucket.StartDate, "tokens": bucket.Tokens})
		}
		sort.Slice(daily, func(i, j int) bool { return daily[i]["date"].(string) < daily[j]["date"].(string) })
		out["daily_usage"] = daily
	} else {
		out["daily_usage"] = nil
	}
	var invocations any
	if stats.TopInvocations != nil {
		list := make([]map[string]any, 0, len(stats.TopInvocations))
		for _, item := range stats.TopInvocations {
			list = append(list, map[string]any{
				"invocation_type": strings.TrimSpace(item.Type),
				"plugin_id":       trimmedText(item.PluginID),
				"plugin_name":     trimmedText(item.PluginName),
				"skill_id":        trimmedText(item.SkillID),
				"skill_name":      trimmedText(item.SkillName),
				"usage_count":     item.UsageCount,
			})
		}
		invocations = list
	}
	out["activity_insights"] = map[string]any{
		"fast_mode_percent":        stats.FastModeUsagePercentage,
		"reasoning_effort":         trimmedText(stats.MostUsedReasoningEffort),
		"reasoning_effort_percent": stats.MostUsedReasoningEffortShare,
		"skills_explored":          stats.UniqueSkillsUsed,
		"total_skills_used":        stats.TotalSkillsUsed,
		"total_threads":            stats.TotalThreads,
		"invocations":              invocations,
	}
	return out
}

// 头像来源取自账号自己的资料（CPR profile_avatar）：缓存 10 分钟，未缓存时读取一次资料。
const avatarSourceTTL = 10 * time.Minute

type avatarSourceEntry struct {
	url string
	at  time.Time
}

func (s *Server) avatarSource(ctx context.Context, accountID string) (string, error) {
	s.avatarMu.Lock()
	entry, ok := s.avatarSources[accountID]
	s.avatarMu.Unlock()
	if ok && time.Since(entry.at) < avatarSourceTTL {
		if entry.url == "" {
			return "", errors.New("the account has no avatar")
		}
		return entry.url, nil
	}
	profile, _, err := s.accountProfile(ctx, accountID)
	if err != nil {
		return "", err
	}
	if source, _ := profile["image_url"].(string); source != "" {
		return source, nil
	}
	return "", errors.New("the account has no avatar")
}

func (s *Server) accountProfile(ctx context.Context, accountID string) (map[string]any, int, error) {
	status, data, _, err := s.withAccount(accountID, func(account Account) (int, []byte, error) {
		return s.accountRequestLimited(ctx, account, s.accountBaseURL()+"/profiles/me", maxProfileBodyBytes, nil)
	})
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if status < 200 || status >= 300 {
		return nil, upstreamStatusForClient(status), errors.New("profile query failed")
	}
	var wire profileWire
	if json.Unmarshal(data, &wire) != nil || wire.Stats == nil {
		return nil, http.StatusBadGateway, errors.New("invalid profile-statistics response")
	}
	profile := projectProfile(wire)
	source, _ := profile["image_url"].(string)
	s.avatarMu.Lock()
	if len(s.avatarSources) >= 4096 {
		s.avatarSources = map[string]avatarSourceEntry{}
	}
	s.avatarSources[accountID] = avatarSourceEntry{url: source, at: time.Now()}
	s.avatarMu.Unlock()
	return profile, http.StatusOK, nil
}

// backendAPIBase 返回账号所在的 /backend-api 根（订阅与头像）。
func (s *Server) backendAPIBase() string {
	base := strings.TrimRight(s.cfg.UpstreamBaseURL, "/")
	if index := strings.Index(base, "/backend-api"); index >= 0 {
		return base[:index+len("/backend-api")]
	}
	return base + "/backend-api"
}

func shortText(value any) any {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	if !ok || text == "" || len(text) > 64 {
		return nil
	}
	for _, c := range text {
		if c < 32 || c == 127 {
			return nil
		}
	}
	return text
}

// accountSubscription 是可选展示：任何失败都返回未知（subscription=null），不影响账号状态。
func (s *Server) accountSubscription(ctx context.Context, accountID string) map[string]any {
	account, ok := s.store.Get(accountID)
	if !ok || account.APIKey != "" || account.ChatGPTAccountID == "" || len(account.ChatGPTAccountID) > 512 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, subscriptionTimeout)
	defer cancel()
	target, err := url.Parse(s.backendAPIBase() + "/subscriptions")
	if err != nil {
		return nil
	}
	target.RawQuery = url.Values{"account_id": {account.ChatGPTAccountID}}.Encode()
	origin := target.Scheme + "://" + target.Host
	status, data, err := s.accountRequestLimited(ctx, account, target.String(), maxSubscriptionBodyBytes, map[string]string{"Origin": origin, "Referer": origin + "/"})
	if err != nil || status < 200 || status >= 300 {
		return nil
	}
	var value map[string]any
	if json.Unmarshal(data, &value) != nil {
		return nil
	}
	until, _ := value["active_until"].(string)
	expires, err := time.Parse(time.RFC3339, strings.TrimSpace(until))
	if err != nil {
		return nil
	}
	out := map[string]any{"expires_at": expires.UTC(), "observed_at": time.Now().UTC(), "starts_at": nil, "will_renew": nil}
	if start, ok := value["active_start"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(start)); err == nil {
			out["starts_at"] = parsed.UTC()
		}
	}
	if renew, ok := value["will_renew"].(bool); ok {
		out["will_renew"] = renew
	}
	out["billing_period"] = shortText(value["billing_period"])
	out["billing_currency"] = shortText(value["billing_currency"])
	// 购买平台（chatgpt_web / ios / android 等），控制面映射为订阅渠道（Stripe / Apple / Google）
	out["purchase_origin_platform"] = shortText(value["purchase_origin_platform"])
	return out
}

// accountRequestLimited 发送账号身份的 GET（UA、认证、账号 ID），读取不超过 limit 的正文；超限视为失败。
func (s *Server) accountRequestLimited(ctx context.Context, account Account, target string, limit int64, extra map[string]string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	applyAccountIdentity(req.Header, account, s.globalProfile())
	for key, value := range extra {
		req.Header.Set(key, value)
	}
	client, err := s.clientFor(account)
	if err != nil {
		return 0, nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return 0, nil, err
	}
	if int64(len(data)) > limit {
		return 0, nil, errors.New("upstream response exceeded the body limit")
	}
	return resp.StatusCode, data, nil
}

// avatarRequest 校验来源：不允许凭据、查询串与片段；Estuary 改写到账号上游并带账号凭据，Auth0 只带 UA。
func (s *Server) avatarRequest(ctx context.Context, account Account, source string) (*http.Request, bool, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return nil, false, errAvatarSource
	}
	profile := s.globalProfile()
	switch parsed.Scheme + "://" + parsed.Host {
	case officialAvatarOrigin:
		opaque, ok := strings.CutPrefix(parsed.EscapedPath(), officialAvatarPrefix)
		if !ok || opaque == "" {
			return nil, false, errAvatarSource
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.backendAPIBase()+"/estuary/public_content/enc/"+opaque, nil)
		if err != nil {
			return nil, false, errAvatarSource
		}
		req.Header.Set("User-Agent", profile.desktopUserAgent())
		req.Header.Set("Authorization", "Bearer "+account.AccessToken)
		if account.ChatGPTAccountID != "" {
			req.Header.Set("chatgpt-account-id", account.ChatGPTAccountID)
		}
		req.Header.Set("originator", profile.Originator)
		return req, true, nil
	case auth0AvatarOrigin:
		if rest, ok := strings.CutPrefix(parsed.EscapedPath(), auth0AvatarPrefix); !ok || rest == "" {
			return nil, false, errAvatarSource
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil {
			return nil, false, errAvatarSource
		}
		req.Header.Set("User-Agent", profile.desktopUserAgent())
		return req, false, nil
	}
	return nil, false, errAvatarSource
}

func (s *Server) accountAvatar(w http.ResponseWriter, r *http.Request, accountID string) {
	account, ok := s.store.Get(accountID)
	if !ok || account.APIKey != "" {
		writeError(w, http.StatusNotFound, "account_not_found", "account not found")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	source, err := s.avatarSource(ctx, accountID)
	if err != nil {
		writeError(w, http.StatusNotFound, "avatar_unavailable", err.Error())
		return
	}
	req, withAccount, err := s.avatarRequest(ctx, account, source)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_avatar_source", err.Error())
		return
	}
	client := &http.Client{Timeout: 0}
	if withAccount {
		if client, err = s.clientFor(account); err != nil {
			writeError(w, http.StatusBadGateway, "upstream_unavailable", "profile avatar transport is unavailable")
			return
		}
	}
	headerTimer := time.AfterFunc(avatarHeadersTimeout, cancel)
	resp, err := client.Do(req)
	headerTimer.Stop()
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_unavailable", "profile avatar transport is unavailable")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeError(w, upstreamStatusForClient(resp.StatusCode), "avatar_unavailable", "profile avatar upstream returned an error")
		return
	}
	for _, name := range []string{"Content-Type", "Content-Length", "ETag"} {
		if value := resp.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(http.StatusOK)
	// 空闲 30 秒无数据即中止；不累积完整正文
	idle := time.AfterFunc(avatarIdleTimeout, cancel)
	defer idle.Stop()
	buffer := make([]byte, 32<<10)
	flusher, _ := w.(http.Flusher)
	for {
		n, err := resp.Body.Read(buffer)
		if n > 0 {
			idle.Reset(avatarIdleTimeout)
			if _, werr := w.Write(buffer[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

// accountInsight 处理 GET 的资料类账号动作；返回 false 表示不是这类动作。
func (s *Server) accountInsight(w http.ResponseWriter, r *http.Request, accountID, action string) bool {
	if r.Method != http.MethodGet {
		return false
	}
	switch action {
	case "profile":
		result, status, err := s.accountProfile(r.Context(), accountID)
		if err != nil {
			writeError(w, status, "profile_unavailable", err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": result})
	case "subscription":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subscription": s.accountSubscription(r.Context(), accountID)})
	case "avatar":
		s.accountAvatar(w, r, accountID)
	default:
		return false
	}
	return true
}

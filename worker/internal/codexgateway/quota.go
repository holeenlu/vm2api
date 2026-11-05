package codexgateway

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type QuotaEvidence struct {
	Primary              map[string]any `json:"primary_window,omitempty"`
	Secondary            map[string]any `json:"secondary_window,omitempty"`
	RPMRemaining         *int64         `json:"rpm_remaining,omitempty"`
	ConcurrencyRemaining *int64         `json:"concurrency_remaining,omitempty"`
	Reached              string         `json:"rate_limit_reached_type,omitempty"`
	Credits              map[string]any `json:"credits,omitempty"`
	ActiveLimit          string         `json:"active_limit,omitempty"`
	PlanType             string         `json:"plan_type,omitempty"`
	Confidence           string         `json:"confidence"`
	UpdatedAt            string         `json:"updated_at"`
	// Buckets 是默认 codex 桶以外的具名额度桶（limit_id → 窗口与 allowed/limit_reached），只作展示事实
	Buckets map[string]map[string]any `json:"buckets,omitempty"`
}

// rateLimitHeaderSuffixes：具名额度桶的头名后缀（CPR rate_limit_id_from_header_name）。
var rateLimitHeaderSuffixes = []string{"-primary-used-percent", "-primary-window-minutes", "-primary-reset-at", "-secondary-used-percent", "-secondary-window-minutes", "-secondary-reset-at", "-limit-name", "-allowed", "-limit-reached"}

func normalizeLimitID(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
}

func parseQuotaHeaders(headers map[string][]string, now time.Time) QuotaEvidence {
	flat := map[string]string{}
	for key, values := range headers {
		if len(values) > 0 {
			flat[strings.ToLower(key)] = values[len(values)-1]
		}
	}
	windowFor := func(base, role string) map[string]any {
		prefix := base + role + "-"
		used, usedOK := number(flat[prefix+"used-percent"])
		minutes, minutesOK := number(flat[prefix+"window-minutes"])
		resetAt, resetAtOK := number(flat[prefix+"reset-at"])
		resetAfter, resetAfterOK := number(flat[prefix+"reset-after-seconds"])
		if !usedOK && !minutesOK && !resetAtOK && !resetAfterOK {
			return nil
		}
		result := map[string]any{}
		if usedOK {
			result["used_percent"] = used
		}
		if minutesOK {
			result["window_minutes"] = minutes
		}
		if resetAtOK {
			result["reset_at"] = time.Unix(int64(resetAt), 0).UTC().Format(time.RFC3339Nano)
		} else if resetAfterOK {
			result["reset_at"] = now.Add(time.Duration(resetAfter) * time.Second).UTC().Format(time.RFC3339Nano)
			result["reset_after_seconds"] = resetAfter
		}
		if resetAfterOK {
			result["reset_after_seconds"] = resetAfter
		}
		return result
	}
	window := func(role string) map[string]any { return windowFor("x-codex-", role) }
	evidence := QuotaEvidence{Primary: window("primary"), Secondary: window("secondary"), Reached: flat["x-codex-rate-limit-reached-type"], Confidence: "unknown", UpdatedAt: now.UTC().Format(time.RFC3339Nano)}
	for name := range flat {
		rest, ok := strings.CutPrefix(name, "x-")
		if !ok {
			continue
		}
		for _, suffix := range rateLimitHeaderSuffixes {
			raw, found := strings.CutSuffix(rest, suffix)
			if !found || raw == "" {
				continue
			}
			id := normalizeLimitID(raw)
			if id == "codex" || evidence.Buckets[id] != nil {
				break
			}
			base := "x-" + strings.ReplaceAll(id, "_", "-") + "-"
			bucket := map[string]any{}
			if w := windowFor(base, "primary"); w != nil {
				bucket["primary_window"] = w
			}
			if w := windowFor(base, "secondary"); w != nil {
				bucket["secondary_window"] = w
			}
			if value := strings.TrimSpace(flat[base+"limit-name"]); value != "" {
				bucket["limit_name"] = value
			}
			if value, ok := parseBool(flat[base+"allowed"]); ok {
				bucket["allowed"] = value
			}
			if value, ok := parseBool(flat[base+"limit-reached"]); ok {
				bucket["limit_reached"] = value
			}
			if len(bucket) > 0 {
				if evidence.Buckets == nil {
					evidence.Buckets = map[string]map[string]any{}
				}
				evidence.Buckets[id] = bucket
			}
			break
		}
	}
	evidence.Credits = parseCreditHeaders(flat, now)
	evidence.ActiveLimit = strings.TrimSpace(flat["x-codex-active-limit"])
	evidence.PlanType = strings.TrimSpace(flat["x-codex-plan-type"])
	if value, ok := number(flat["x-ratelimit-remaining-requests"]); ok {
		v := int64(value)
		evidence.RPMRemaining = &v
	}
	if value, ok := number(flat["x-codex-concurrency-remaining"]); ok {
		v := int64(value)
		evidence.ConcurrencyRemaining = &v
	}
	if evidence.Primary != nil || evidence.Secondary != nil || evidence.RPMRemaining != nil || evidence.ConcurrencyRemaining != nil || evidence.Reached != "" || evidence.Credits != nil {
		evidence.Confidence = "partial"
	}
	if evidence.Primary != nil && evidence.Secondary != nil {
		evidence.Confidence = "complete"
	}
	if evidence.Primary == nil && evidence.Secondary == nil && evidence.Reached == "" && evidence.Credits == nil {
		evidence.Confidence = "unknown"
	}
	return evidence
}

func number(value string) (float64, bool) {
	if strings.TrimSpace(value) == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return n, err == nil
}

func quotaMap(evidence QuotaEvidence) map[string]any {
	data, _ := json.Marshal(evidence)
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	return value
}

func quotaExhausted(quota map[string]any, now time.Time) (bool, time.Time) {
	var earliest time.Time
	for _, key := range []string{"primary_window", "secondary_window"} {
		window, ok := quota[key].(map[string]any)
		if !ok {
			continue
		}
		used, _ := window["used_percent"].(float64)
		if used < 100 {
			continue
		}
		reset, _ := window["reset_at"].(string)
		at, err := time.Parse(time.RFC3339Nano, reset)
		if err != nil || !at.After(now) {
			continue
		}
		if earliest.IsZero() || at.Before(earliest) {
			earliest = at
		}
	}
	return !earliest.IsZero(), earliest
}

// parseRateLimitsEvent 解析 SSE / WS 中的 codex.rate_limits 事件（与 x-codex-* 头同一口径）。
// 上游窗口字段为 reset_at（unix 秒）与 reset_after_seconds（对齐 CPR parse_rate_limits_event 与官方 Codex 客户端）；
// resets_at / resets_in_seconds 只出现在 usage_limit_reached 错误体，不是本事件的字段。
func parseRateLimitsEvent(event map[string]any, now time.Time) map[string]any {
	limits, _ := event["rate_limits"].(map[string]any)
	if limits == nil {
		limits = event
	}
	result := map[string]any{}
	for role, key := range map[string]string{"primary": "primary_window", "secondary": "secondary_window"} {
		window, ok := limits[role].(map[string]any)
		if !ok {
			continue
		}
		out := map[string]any{}
		if used, ok := window["used_percent"].(float64); ok {
			out["used_percent"] = used
		}
		if minutes, ok := window["window_minutes"].(float64); ok {
			out["window_minutes"] = minutes
		}
		if reset, ok := window["reset_at"].(float64); ok && reset > 0 {
			out["reset_at"] = time.Unix(int64(reset), 0).UTC().Format(time.RFC3339Nano)
		} else if after, ok := window["reset_after_seconds"].(float64); ok {
			out["reset_at"] = now.Add(time.Duration(after) * time.Second).UTC().Format(time.RFC3339Nano)
		}
		if after, ok := window["reset_after_seconds"].(float64); ok {
			out["reset_after_seconds"] = after
		}
		if len(out) > 0 {
			result[key] = out
		}
	}
	if credits, ok := limits["credits"].(map[string]any); ok && len(credits) > 0 {
		result["credits"] = credits
	}
	if plan, ok := limits["plan_type"].(string); ok && plan != "" {
		result["plan_type"] = plan
	}
	if len(result) > 0 {
		result["updated_at"] = now.UTC().Format(time.RFC3339Nano)
		if result["primary_window"] != nil && result["secondary_window"] != nil {
			result["confidence"] = "complete"
		} else {
			result["confidence"] = "partial"
		}
	}
	return result
}

// parseCreditHeaders 与 CPR parse_credits_from_lookup 相同：has_credits 与 unlimited 都存在才算有效快照。
func parseCreditHeaders(flat map[string]string, now time.Time) map[string]any {
	hasCredits, okHas := parseBool(flat["x-codex-credits-has-credits"])
	unlimited, okUnlimited := parseBool(flat["x-codex-credits-unlimited"])
	if !okHas || !okUnlimited {
		return nil
	}
	credits := map[string]any{"has_credits": hasCredits, "unlimited": unlimited, "fetched_at": now.UTC().Format(time.RFC3339Nano)}
	if balance := strings.TrimSpace(flat["x-codex-credits-balance"]); balance != "" {
		credits["balance"] = balance
	}
	return credits
}

func parseBool(value string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1", "yes":
		return true, true
	case "false", "0", "no":
		return false, true
	}
	return false, false
}

// isCodexQuotaHeader 对齐 CPR is_codex_quota_header_name：这类头会让官方客户端显示上游账号的额度，
// 不能穿过账号隔离边界下发给调用方；通用 x-ratelimit-* 与 Retry-After 仍可下发。
func isCodexQuotaHeader(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch lower {
	case "x-codex-credits-has-credits", "x-codex-credits-unlimited", "x-codex-credits-balance", "x-codex-active-limit",
		"x-codex-plan-type", "x-codex-promo-message", "x-codex-rate-limit-reached-type", "x-codex-primary-over-secondary-limit-percent":
		return true
	}
	if !strings.HasPrefix(lower, "x-codex") {
		return false
	}
	for _, suffix := range []string{"-primary-used-percent", "-primary-window-minutes", "-primary-reset-at", "-primary-reset-after-seconds", "-secondary-used-percent", "-secondary-window-minutes", "-secondary-reset-at", "-secondary-reset-after-seconds", "-limit-name", "-allowed", "-limit-reached"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

// mergeQuotaWindows 把局部额度观测并入快照：顶层字段按新值覆盖；同一时长的窗口若新观测缺少重置时间且已用比例
// 没有回落（同一周期），沿用原窗口的 reset_at，避免一次不带重置时间的读数把已知周期清掉。
func mergeQuotaWindows(current, partial map[string]any) map[string]any {
	merged := make(map[string]any, len(current)+len(partial))
	for key, value := range current {
		merged[key] = value
	}
	for key, value := range partial {
		if value == nil {
			continue
		}
		next, isWindow := value.(map[string]any)
		previous, hadWindow := current[key].(map[string]any)
		if isWindow && hadWindow && (key == "primary_window" || key == "secondary_window") {
			value = keepWindowReset(previous, next)
		}
		merged[key] = value
	}
	return merged
}

func keepWindowReset(previous, next map[string]any) map[string]any {
	if _, ok := next["reset_at"]; ok {
		return next
	}
	reset, ok := previous["reset_at"].(string)
	if !ok || reset == "" {
		return next
	}
	if at, err := time.Parse(time.RFC3339Nano, reset); err != nil || !at.After(time.Now()) {
		return next
	}
	if previous["window_minutes"] != nil && next["window_minutes"] != nil && previous["window_minutes"] != next["window_minutes"] {
		return next
	}
	if was, ok := previous["used_percent"].(float64); ok {
		if now, ok := next["used_percent"].(float64); ok && now < was-1 {
			return next
		}
	}
	out := make(map[string]any, len(next)+1)
	for key, value := range next {
		out[key] = value
	}
	out["reset_at"] = reset
	return out
}

// receiptQuota 合并响应头与流内 codex.rate_limits 的额度观测，写入回执供控制面配对用量（上游 WS 只在流内给出额度）。
func receiptQuota(header http.Header, stream map[string]any, now time.Time) (map[string]any, string) {
	var quota map[string]any
	confidence := "unknown"
	if header != nil {
		evidence := parseQuotaHeaders(header, now)
		quota = quotaMap(evidence)
		confidence = evidence.Confidence
	}
	if len(stream) == 0 {
		return quota, confidence
	}
	merged := mergeQuotaWindows(quota, stream)
	switch {
	case merged["primary_window"] != nil && merged["secondary_window"] != nil:
		confidence = "complete"
	case merged["primary_window"] != nil || merged["secondary_window"] != nil:
		confidence = "partial"
	}
	merged["confidence"] = confidence
	return merged, confidence
}

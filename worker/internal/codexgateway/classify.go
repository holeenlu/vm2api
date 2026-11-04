package codexgateway

import (
	"encoding/base64"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// failureCategory 与 codex-proxy-rs 的 CodexFailureCategory 一一对应，判定顺序见 classifyFailure。
type failureCategory string

const (
	categoryFlexUnavailable        failureCategory = "flex_unavailable"
	categoryTurnRateLimited        failureCategory = "turn_rate_limited"
	categoryCapacity               failureCategory = "capacity_unavailable"
	categoryUsageLimit             failureCategory = "usage_limit_exhausted"
	categoryRateLimited            failureCategory = "rate_limited"
	categoryInvalidRequest         failureCategory = "invalid_request"
	categoryModelUnsupported       failureCategory = "model_unsupported"
	categoryIdentityVerification   failureCategory = "identity_verification_required"
	categoryBanned                 failureCategory = "banned"
	categoryCredentialExpired      failureCategory = "credential_expired"
	categoryCloudflareChallenge    failureCategory = "cloudflare_challenge"
	categoryCloudflarePathBlocked  failureCategory = "cloudflare_path_blocked"
	categoryQuotaExhausted         failureCategory = "quota_exhausted"
	categoryPermissionDenied       failureCategory = "permission_denied"
	categoryTimeout                failureCategory = "timeout"
	categoryUnavailable            failureCategory = "unavailable"
	categoryTransport              failureCategory = "transport"
	identityAuthorizationErrHeader                 = "x-openai-authorization-error"
	identityErrorJSONHeader                        = "x-error-json"
)

const (
	// 服务端 503 的同号退避起点；容量拒绝（server_is_overloaded/slow_down）不同号重试
	serverErrorBackoffBase     = 500 * time.Millisecond
	serverErrorRetryLimit      = 5
	serverErrorBackoffMax      = 2 * time.Second
	maxAccountSwitches         = 3
	maxTotalAttempts           = 32
	defaultMaxRetryAfter       = 240 * time.Second
	defaultRateLimitCooldown   = 60 * time.Second
	defaultUsageLimitCooldown  = 5 * time.Minute
	quotaExhaustedCooldown     = time.Hour
	modelUnsupportedCooldown   = 30 * time.Minute
	cloudflarePathThreshold    = 3
	cloudflareRecoveryStale    = time.Hour
	connectFailureRetryLimit   = 4
	connectFailureRetryBudget  = 30 * time.Second
	sseFailurePreambleMaxBytes = 1 << 20

	// 上游过载与控制面 VM 路径同一套规则（handle-codex.mjs CODEX_POOL_OVERLOAD_*、
	// openai-account-runtime.mjs OPENAI_POOL_OVERLOAD_BPS / OPENAI_OUTLIER_*）：
	// 过载时不同号重试；换号超过 1 次且全池近期失败率中位数 ≥30% 时停止，提示客户端 3 秒后重试；
	// 失败率 ≥70% 且高出其余账号 25 个百分点的离群账号停放 60 秒。
	poolOverloadMaxSwitches = 1
	poolOverloadRetryAfter  = 3 * time.Second
	poolOverloadFailure     = 0.30
	poolSignalMinAccounts   = 3
	overloadOutlierFailure  = 0.70
	overloadOutlierGap      = 0.25
	overloadOutlierHold     = 60 * time.Second
	// preCommitRetryBudget 是提交前同号重试与换号的总时长上限（不含首次排队等待），
	// 超过后交付最后一次失败，避免上游整体过载时客户端长时间无响应。
	preCommitRetryBudget = 30 * time.Second
)

var cloudflareChallengeBackoff = []time.Duration{10 * time.Second, 30 * time.Second, 90 * time.Second, 120 * time.Second}

type upstreamFailure struct {
	Category      failureCategory
	Status        int
	Code          string
	Type          string
	Message       string
	ResetsAt      time.Time
	RetryAfter    time.Duration
	HasRetryAfter bool
	Body          []byte
	header        http.Header
}

type failureSource int

const (
	sourceHTTP failureSource = iota
	sourceSSE
)

// classifyHTTPFailure 解析非 2xx 上游响应。body 已按上限读取。
func classifyHTTPFailure(status int, header http.Header, body []byte, now time.Time) upstreamFailure {
	fields := parseUpstreamError(body)
	failure := upstreamFailure{Status: status, Code: fields.code, Type: fields.errorType, Message: fields.message, ResetsAt: fields.resetsAt, Body: body}
	failure.RetryAfter, failure.HasRetryAfter = parseRetryAfter(header.Get("Retry-After"), now)
	failure.Category = classify(sourceHTTP, status, string(body), fields, header.Get(identityAuthorizationErrHeader), identityErrorCode(header.Get(identityErrorJSONHeader)))
	return failure
}

// classifySSEFailure 解析流内 response.failed / error 事件（未交付前仍可安全重试）。
// 交付体规整为标准错误对象 {"error":{type,code,message}}：原样转发整段事件时，
// 控制面与客户端只能看到外层 response.failed，丢失过载原因与提示。
func classifySSEFailure(event map[string]any) upstreamFailure {
	raw, _ := json.Marshal(event)
	fields := parseUpstreamError(raw)
	errorType := fields.errorType
	if errorType == "" {
		errorType = "server_error"
	}
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"type": errorType, "code": fields.code, "message": fields.message}})
	failure := upstreamFailure{Code: fields.code, Type: fields.errorType, Message: fields.message, ResetsAt: fields.resetsAt, Body: body}
	failure.Category = classify(sourceSSE, 0, "", fields, "", "")
	return failure
}

type upstreamErrorFields struct {
	code, errorType, message, clientMessage string
	resetsAt                                time.Time
}

func parseUpstreamError(body []byte) upstreamErrorFields {
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return upstreamErrorFields{message: string(body)}
	}
	// 与 CPR 相同：/response/error → error → detail → 根对象
	errValue := root
	found := false
	if response, ok := root["response"].(map[string]any); ok {
		if nested, ok := response["error"].(map[string]any); ok {
			errValue, found = nested, true
		}
	}
	if !found {
		if nested, ok := root["error"].(map[string]any); ok {
			errValue, found = nested, true
		} else if nested, ok := root["detail"].(map[string]any); ok {
			errValue, found = nested, true
		}
	}
	// 找到错误对象后只从它取字段：流内事件的根对象是事件本身，
	// 其 type（response.failed / error）不是错误类型，回落到根会让过载等分类失效
	pick := func(key string) string {
		if value, ok := errValue[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
		if found {
			return ""
		}
		if value, ok := root[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
		return ""
	}
	fields := upstreamErrorFields{code: pick("code"), errorType: pick("type"), clientMessage: pick("message")}
	fields.message = fields.clientMessage
	if fields.message == "" {
		if text, ok := root["error"].(string); ok {
			fields.message = text
		} else {
			fields.message = string(body)
		}
	}
	if seconds, ok := errValue["resets_at"].(float64); ok && seconds > 0 {
		fields.resetsAt = time.Unix(int64(seconds), 0).UTC()
	}
	return fields
}

func identityErrorCode(encoded string) string {
	if strings.TrimSpace(encoded) == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return ""
	}
	var value struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(decoded, &value) != nil {
		return ""
	}
	return value.Error.Code
}

func classify(source failureSource, status int, body string, fields upstreamErrorFields, identityAuthorization, identityCode string) failureCategory {
	code := normalizeToken(fields.code)
	errorType := normalizeToken(fields.errorType)
	identityAuthorization = normalizeToken(identityAuthorization)
	identityCode = normalizeToken(identityCode)
	message := strings.ToLower(fields.message)
	body = strings.ToLower(body)
	if code == "flex_unavailable" {
		return categoryFlexUnavailable
	}
	if code == "turn_rate_limit_exceeded" {
		return categoryTurnRateLimited
	}
	if isCapacityError(fields.code, fields.errorType, fields.clientMessage) {
		return categoryCapacity
	}
	// 429 只有结构化 error.type=usage_limit_reached 才确认额度窗口耗尽
	if source == sourceHTTP && status == http.StatusTooManyRequests {
		if errorType == "usage_limit_reached" {
			return categoryUsageLimit
		}
		return categoryRateLimited
	}
	if code == "unsupported_value" || (source == sourceSSE && code == "invalid_prompt") {
		return categoryInvalidRequest
	}
	if fields.code == "model_not_found" && (status == 0 || status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusNotFound) {
		return categoryModelUnsupported
	}
	identitySignals := []string{identityCode, identityAuthorization, code, errorType, message, body}
	for _, signal := range identitySignals {
		if isIdentityVerificationRequired(signal) {
			return categoryIdentityVerification
		}
	}
	for _, signal := range identitySignals {
		if isBannedAccount(signal) {
			return categoryBanned
		}
	}
	authStatus := status == http.StatusUnauthorized || status == http.StatusForbidden
	expired := status == http.StatusUnauthorized
	for _, signal := range []string{identityCode, identityAuthorization, code, errorType} {
		if isExpiredCredential(signal) {
			expired = true
		}
	}
	if !expired && authStatus && (isExpiredCredential(message) || isExpiredCredential(body)) {
		expired = true
	}
	if expired {
		return categoryCredentialExpired
	}
	if status == http.StatusForbidden && isCloudflareChallenge(body) {
		return categoryCloudflareChallenge
	}
	if source == sourceHTTP && status == http.StatusNotFound && strings.TrimSpace(body) == "" {
		return categoryCloudflarePathBlocked
	}
	if isQuotaSignal(code) || isQuotaSignal(errorType) || status == http.StatusPaymentRequired {
		return categoryQuotaExhausted
	}
	if isUsageLimitSignal(code) || isUsageLimitSignal(errorType) {
		return categoryUsageLimit
	}
	if isRateLimitSignal(code) || isRateLimitSignal(errorType) {
		return categoryRateLimited
	}
	if strings.Contains(message, "usage limit") || strings.Contains(body, "usage limit") {
		return categoryUsageLimit
	}
	if isQuotaMessage(message) || isQuotaMessage(body) {
		return categoryQuotaExhausted
	}
	if strings.Contains(message, "rate limit") || strings.Contains(body, "rate limit") {
		return categoryRateLimited
	}
	if status == http.StatusTooManyRequests {
		return categoryRateLimited
	}
	switch {
	case status == 0:
		return categoryUnavailable
	case status == 400 || status == 404 || status == 409 || status == 422:
		return categoryInvalidRequest
	case status == 403:
		return categoryPermissionDenied
	case status == 408 || status == 504:
		return categoryTimeout
	case status >= 500 && status <= 599:
		return categoryUnavailable
	}
	return categoryTransport
}

func normalizeToken(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func isCapacityError(code, errorType, message string) bool {
	code = normalizeToken(code)
	errorType = normalizeToken(errorType)
	switch errorType {
	case "", "server_error", "service_unavailable_error", "invalid_request_error", "rate_limit_error", "server_is_overloaded", "slow_down":
	default:
		return false
	}
	if code == "server_is_overloaded" || code == "slow_down" {
		return true
	}
	if code != "" && code != "server_error" && code != "service_unavailable_error" {
		return false
	}
	if errorType == "server_is_overloaded" || errorType == "slow_down" {
		return true
	}
	message = normalizeToken(message)
	return message == "server_is_overloaded" || message == "slow_down" ||
		strings.Contains(message, "selected model is at capacity") ||
		strings.Contains(message, "server is overloaded") ||
		strings.Contains(message, "server_overloaded")
}

func isIdentityVerificationRequired(value string) bool {
	return value == "identity_verification_required" || value == "verification_required" || strings.Contains(value, "identity verification is required")
}

func isBannedAccount(value string) bool {
	switch value {
	case "account_banned", "account_deactivated", "account_disabled", "account_suspended", "deactivated_workspace", "organization_disabled", "workspace_deactivated":
		return true
	}
	for _, phrase := range []string{"account is banned", "account has been banned", "account deactivated", "account has been deactivated", "account disabled", "account has been disabled", "account suspended", "organization has been disabled", "workspace has been deactivated", "deactivated_workspace"} {
		if strings.Contains(value, phrase) {
			return true
		}
	}
	return false
}

func isExpiredCredential(value string) bool {
	switch value {
	case "token_invalid", "token_invalidated", "token_expired", "token_revoked", "refresh_token_invalidated", "unauthorized", "invalid_api_key", "authentication_error", "access_token_expired":
		return true
	}
	for _, phrase := range []string{"token revoked", "token invalidated", "token invalid", "token expired", "unauthorized", "invalid api key"} {
		if strings.Contains(value, phrase) {
			return true
		}
	}
	return false
}

func isUsageLimitSignal(value string) bool {
	return value == "usage_limit_reached" || value == "workspace_owner_usage_limit_reached" || value == "workspace_member_usage_limit_reached"
}

func isRateLimitSignal(value string) bool {
	return value == "rate_limit_exceeded" || value == "rate_limit_reached" || value == "rate_limit_error"
}

func isQuotaSignal(value string) bool {
	switch value {
	case "quota_exhausted", "quota_exceeded", "payment_required", "insufficient_quota", "workspace_owner_credits_depleted", "workspace_member_credits_depleted":
		return true
	}
	return strings.HasPrefix(value, "billing_limit")
}

func isQuotaMessage(value string) bool {
	return strings.Contains(value, "quota") || strings.Contains(value, "payment required") || strings.Contains(value, "billing limit")
}

func isCloudflareChallenge(value string) bool {
	for _, marker := range []string{"cf-mitigated", "cf-chl-bypass", "_cf_chl", "cf_chl", "attention required", "just a moment"} {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

// parseRetryAfter 接受秒数、HTTP 日期和零延迟。
func parseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		if seconds < 0 {
			return 0, false
		}
		return time.Duration(seconds * float64(time.Second)), true
	}
	if at, err := http.ParseTime(value); err == nil {
		if at.Before(now) {
			return 0, true
		}
		return at.Sub(now), true
	}
	return 0, false
}

// isRetryableServerError：503 且 error.code=server_error，只在原账号内恢复。
func (f upstreamFailure) isRetryableServerError() bool {
	return f.Category == categoryUnavailable && f.Status == http.StatusServiceUnavailable && strings.EqualFold(strings.TrimSpace(f.Code), "server_error")
}

// replaySafe 表示上游明确拒绝、未执行本次请求，允许换号或重放。
func (f upstreamFailure) replaySafe() bool {
	if f.isRetryableServerError() || f.cyberPolicy() {
		return true
	}
	switch f.Category {
	case categoryModelUnsupported, categoryCredentialExpired, categoryIdentityVerification, categoryBanned, categoryUsageLimit, categoryRateLimited, categoryQuotaExhausted, categoryCloudflareChallenge, categoryCloudflarePathBlocked, categoryCapacity:
		return true
	}
	return false
}

// sameAccountRetryDelay 返回第 attempt 次（从 0 开始）同账号重试前的等待；ok=false 表示不再同号重试。
func (f upstreamFailure) sameAccountRetryDelay(attempt int, maxRetryAfter time.Duration) (time.Duration, bool) {
	if !f.isRetryableServerError() {
		return 0, false
	}
	limit := serverErrorRetryLimit
	if attempt >= limit {
		return 0, false
	}
	if f.HasRetryAfter {
		// 超过上限的服务器建议跳过同账号等待，按耗尽动作处理
		if f.RetryAfter > maxRetryAfter {
			return 0, false
		}
		return f.RetryAfter, true
	}
	delay := serverErrorBackoffBase << attempt
	return min(delay, serverErrorBackoffMax) + time.Duration(50+rand.IntN(200))*time.Millisecond, true
}

// rotatesAccount：容量拒绝直接换号；503 server_error 同号退避耗尽后直接返回错误。
func (f upstreamFailure) rotatesAccount() bool {
	if f.isRetryableServerError() {
		return false
	}
	return f.replaySafe()
}

// clientProjection 把最终交付的错误投影为客户端可消费的形态（对齐 CPR API 编码出口）。
func (f upstreamFailure) clientProjection() (int, []byte) {
	status := f.Status
	body := f.Body
	if f.Category == categoryCapacity {
		status = http.StatusServiceUnavailable
		var root map[string]any
		if json.Unmarshal(body, &root) == nil {
			if nested, ok := root["error"].(map[string]any); ok {
				for _, key := range []string{"code", "type"} {
					if value, _ := nested[key].(string); value == "server_is_overloaded" || value == "slow_down" {
						nested[key] = "server_error"
					}
				}
				if projected, err := json.Marshal(root); err == nil {
					body = projected
				}
			}
		}
	}
	if status == 0 {
		status = http.StatusBadGateway
	}
	if len(body) == 0 {
		body, _ = json.Marshal(map[string]any{"error": map[string]any{"type": "server_error", "code": string(f.Category), "message": "upstream request failed"}})
	}
	return status, body
}

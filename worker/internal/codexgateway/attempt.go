package codexgateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
	"io"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	sendStateHeader     = "X-Kin-Gateway-Send-State"
	attemptsHeader      = "X-Kin-Gateway-Attempts"
	errorCategoryHeader = "X-Kin-Gateway-Error-Category"
	// outboundSessionHeader 回传实际发往上游的会话 ID（按账号映射后的值），供控制面记录“出站 Session”
	outboundSessionHeader = "X-Kin-Gateway-Outbound-Session"
	errorBodyLimit        = 1 << 20
	sseLineLimit          = 32 << 20
	preambleEventLimit    = 64
	sendStateNotSent      = "not_sent"
	sendStateSent         = "sent"
	sendStateAmbiguous    = "ambiguous"
	terminalCompleted     = "completed"
	terminalAmbiguous     = "ambiguous"
	terminalCancelled     = "cancelled"
	terminalUpstreamError = "upstream_error"
	terminalIncomplete    = "incomplete"
)

// 前导事件交付后仍可透明重试（对齐 CPR is_replaceable_response_prelude：created、in_progress、metadata 与
// codex.rate_limits；created/in_progress 只有 output 为空时才算可替换前导，见 replaceablePrelude）。
var replayablePreambleEvents = map[string]bool{"response.created": true, "response.in_progress": true, "codex.rate_limits": true, "response.metadata": true, "codex.response.metadata": true}

// replaceablePrelude：该事件之后上游断开仍可在同账号透明恢复（CPR 语义边界前的前导）。
func replaceablePrelude(eventType string, event map[string]any) bool {
	switch eventType {
	case "codex.rate_limits", "response.metadata", "codex.response.metadata":
		return true
	case "response.created", "response.in_progress":
		response, _ := event["response"].(map[string]any)
		output, present := response["output"]
		if !present || output == nil {
			return true
		}
		items, ok := output.([]any)
		return ok && len(items) == 0
	}
	return false
}

var terminalStreamEvents = map[string]bool{"response.completed": true, "response.done": true, "response.failed": true, "response.incomplete": true}

type attemptRecord struct {
	Account            string `json:"account"`
	CredentialRevision int64  `json:"credential_revision,omitempty"`
	Status             int    `json:"status,omitempty"`
	Category           string `json:"category,omitempty"`
	SendState          string `json:"send_state"`
	DurationMS         int64  `json:"duration_ms"`
	// UpstreamRequestID / CFRay 关联上游日志（x-request-id、cf-ray），未返回时为空
	UpstreamRequestID string `json:"upstream_request_id,omitempty"`
	CFRay             string `json:"cf_ray,omitempty"`
	// Route 为 bps 表示本次尝试走 BPS 通道（原生通道为空）
	Route string `json:"route,omitempty"`
	// Stage 是 BPS 尝试最后到达的阶段（prepare / images / attachments / compaction / responses / images_endpoint / stream），
	// 用于运维诊断定位失败环节（对齐 sub2api 分阶段诊断）
	Stage string `json:"stage,omitempty"`
}

type dispatchRun struct {
	server   *Server
	envelope Envelope
	target   string
	body     []byte
	guardian bool
	// followOnly：能识别出的后代线程或子代理（严格亲和下只跟随根会话账号）
	followOnly bool
	// clientTurn 是调用方 + 客户端轮次键；retrySuppressed 表示该轮次近期已因 503 server_error 失败交付
	clientTurn      string
	retrySuppressed bool
	// waitDeadline 是请求级共享等待预算：首次入队时设置，换号与重试不重置
	waitDeadline time.Time
	// wsDisabled：本请求的上游 WS 已耗尽恢复或收到 426，后续尝试改走 HTTP
	wsDisabled bool
	// nativeContinuation：连接内续接只能在原上游 WS 上发送，不能回退 HTTP 或换号
	nativeContinuation bool

	// profile 是本请求冻结的上游身份，重试与换号复用
	profile wireProfile
	// privacy 是本请求冻结的隐私规则（nil 表示不执行）
	privacy *compiledPrivacy
	// requestLocation 是已校验的全局请求位置（nil 表示未开启）
	requestLocation *RequestLocation

	attempts []attemptRecord
	exclude  map[string]bool
	switches int
	// overloadSwitches 是因上游过载换号的次数；poolOverloadStop 表示因全池过载停止换号
	overloadSwitches int
	// BPS 通道：bpsRequest 是请求的可承载性（首次选号时判定）；bpsAttempt 表示当前尝试走 BPS；
	// bpsDone 表示本请求已结束 BPS 阶段（无可用 BPS、协议转换拒绝或 BPS 换号用尽），之后只走原生通道；
	// bpsExclude 是 BPS 阶段已失败的账号（同一账号仍可走原生），bpsSwitches 是 BPS 阶段换号次数，不计入 switches
	bpsChecked  bool
	bpsRequest  bpsRequest
	bpsAttempt  bool
	bpsDone     bool
	bpsExclude  map[string]bool
	bpsSwitches int
	// bpsImages 是本请求已上传的图片计划；bpsOwnershipRetried 表示已因附件归属失败重传过一次
	bpsImages         *basispoints.NativeImages
	bpsImagePlan      *bpsImagePlan
	bpsImageWindow    []any
	bpsRefreshRetried bool
	// bpsStage 是当前 BPS 尝试到达的阶段（attemptRecord.Stage）
	bpsStage string
	// bpsContinued：previous_response_id 已按 BPS 快照展开为完整历史
	bpsContinued        bool
	bpsOwnershipRetried bool
	// 历史来源锁定（route_provenance.go）：routePinned 为历史产生的通道；routeLocked 表示历史不可重放但来源未知，
	// BPS 已尝试过就不再转原生；bpsTried 表示本请求发出过 BPS 尝试
	routePinned string
	routeLocked bool
	// historyOwner 是请求历史里最新原生密文的签发账号：原生选号优先回到它（selectRequest.HistoryOwner）
	historyOwner string
	// encryptedRecoveries 是本请求已做的密文历史缩减次数（encrypted_history_recovery.go，最多两步）
	encryptedRecoveries int
	bpsTried            bool
	poolOverloadStop    bool
	connects            int
	connectAt           time.Time
	lastFail            *upstreamFailure
	lastAcct            Account
	sentAny             bool
	firstByte           time.Time
	startedAt           time.Time
	// protection 是本请求冻结的错误保护策略；countable=false（预热）时不计数
	protection        *ProtectionPolicy
	countable         bool
	protectionVersion int64
	// affinity 是本次尝试所用上游 WS 握手的路由 pin（HTTP 尝试为空），响应开始时随归属一起记录
	affinity *routingAffinity
	// attemptState 是本次尝试的账号归属结论与发送的 turn-state
	attemptState attemptState
	// sentServiceTier 是本次尝试实际发送的 service_tier（随响应头与 Receipt 交给控制面计费）
	sentServiceTier string
	// preCommit 是提交前时限（RequestTimeout）的计时器；提交响应后停止，流式正文不受总时长限制
	preCommit *time.Timer
	// wsAttempt 表示当前尝试走上游 WS；wsRecoveries 是首个语义输出前的同账号恢复次数
	wsAttempt    bool
	wsRecoveries int
	// inbound 是本次分发透传到上游的入站头与推导身份头（见 identity.go）
	inbound map[string]string
	// anchor 是本次分发的会话锚点（WS 空闲池键的一部分），anchorDone 表示已计算
	anchor     string
	anchorDone bool
}

// execute 在提交（WriteHeader）前完成同账号重试、401 刷新恢复与换号；提交后不再重试。
func (d *dispatchRun) execute(ctx context.Context, w http.ResponseWriter) {
	s := d.server
	d.exclude = map[string]bool{}
	d.bpsExclude = map[string]bool{}
	for _, id := range d.envelope.Scope.ExcludeAccounts {
		d.exclude[id] = true
		d.bpsExclude[id] = true
	}
	d.startedAt = time.Now().UTC()
	model := d.envelope.Model
	if !d.resolveRouteHistory(w) {
		return
	}
	if d.envelope.Scheduling.RoutePolicy == routePolicyNativeOnly {
		d.bpsDone = true
	}
	for len(d.attempts) < maxTotalAttempts {
		// 先走 BPS 阶段（账号 BPS 名单命中、授权可用）；没有就绪的 BPS 账号时不排队，进入原生阶段
		useBPS := d.bpsRoute()
		if !useBPS && !d.routeAllowsNative(w) {
			return
		}
		exclude := d.exclude
		if useBPS {
			exclude = d.bpsExclude
		}
		account, err := s.store.Acquire(ctx, selectRequest{Scope: d.envelope.Scope, Model: model, Operation: d.envelope.Operation, Exclude: exclude, Guardian: d.guardian, Policy: d.envelope.Scheduling,
			ClientScope: d.envelope.ClientScope, FollowOnly: d.followOnly, Continuation: d.continuation(), SessionExclude: s.cyberPolicy.excluded(d.cyberPolicyKey(), time.Now()),
			BPS: useBPS, BPSRequest: d.bpsRequest, NoWait: useBPS, HistoryOwner: d.nativeHistoryOwner(useBPS)}, &d.waitDeadline)
		if err != nil {
			if ctx.Err() != nil {
				d.finishCancelled(w)
				return
			}
			if useBPS {
				d.bpsDone = true
				continue
			}
			d.finishWithoutAccount(w, err)
			return
		}
		d.bpsAttempt = useBPS
		if useBPS {
			d.bpsTried = true
		}
		outcome := d.runAccount(ctx, w, account)
		switch outcome {
		case outcomeDone:
			return
		case outcomeDoneRotated:
			continue
		case outcomeRotate:
			d.release(account.ID, "")
			if d.pinned() {
				// 续接绑定原账号，不能把增量输入转发给其他账号
				d.deliverContinuationFailure(w)
				return
			}
			if useBPS {
				// BPS 阶段换号单独计数；用尽后本请求只走原生通道（同一账号仍可走原生）
				d.bpsFailed(account.ID)
				if d.retryBudgetSpent(0) {
					d.deliverFailure(w)
					return
				}
				continue
			}
			d.exclude[account.ID] = true
			d.switches++
			if d.switches > maxAccountSwitches || d.retryBudgetSpent(0) {
				d.deliverFailure(w)
				return
			}
			if d.lastFail != nil && d.lastFail.Category == categoryCapacity {
				d.overloadSwitches++
				if d.overloadSwitches > poolOverloadMaxSwitches && s.store.poolOverloaded(time.Now()) {
					d.poolOverloadStop = true
					d.deliverFailure(w)
					return
				}
			}
		}
	}
	d.deliverFailure(w)
}

// retryBudgetSpent 判断再等待 next 后是否超过提交前重试总时长。
func (d *dispatchRun) retryBudgetSpent(next time.Duration) bool {
	return !d.startedAt.IsZero() && time.Since(d.startedAt)+next >= preCommitRetryBudget
}

type accountOutcome int

const (
	outcomeDone accountOutcome = iota
	outcomeRotate
)

func withRuntime(credential, runtime Account) Account {
	credential.InFlight = runtime.InFlight
	credential.GuardianInFlight = runtime.GuardianInFlight
	return credential
}

func (d *dispatchRun) release(id, errValue string) {
	d.server.store.ReleaseLease(id, d.guardian, errValue)
}

// protectFailure 按尝试计入账号错误保护（每次已发送的上游失败计一次）。
func (d *dispatchRun) protectFailure(id string, failure upstreamFailure) {
	if !d.countable || d.protection == nil {
		return
	}
	if matched := d.protection.matchingRules(failure); len(matched) > 0 {
		d.server.store.RecordProtectionFailure(id, d.protection, matched, time.Now())
	}
}

func (d *dispatchRun) feedback(id string, failure upstreamFailure) {
	if kind, ok := feedbackForFailure(failure); ok {
		d.server.store.RecordFeedback(id, kind, 0)
	}
	if failure.Category == categoryCapacity {
		d.server.store.parkOverloadOutlier(id, time.Now())
	}
}

// runAccount 在单个账号上执行（含同号退避重试），返回是否需要换号。
func (d *dispatchRun) runAccount(ctx context.Context, w http.ResponseWriter, account Account) accountOutcome {
	s := d.server
	sameRetries := 0
	d.lastAcct = account
	for len(d.attempts) < maxTotalAttempts {
		attemptStarted := time.Now()
		d.protectionVersion = s.store.ProtectionVersion(account.ID)
		resp, wrote, err := d.send(ctx, account)
		record := attemptRecord{Account: account.ID, CredentialRevision: account.CredentialRevision}
		if d.bpsAttempt {
			record.Route, record.Stage = "bps", d.bpsStage
		}
		if err != nil {
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			if ctx.Err() != nil {
				record.SendState = sendStateAmbiguous
				if !wrote {
					record.SendState = sendStateNotSent
				}
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				d.finishCancelled(w)
				return outcomeDone
			}
			if wrote {
				// 已写出请求而结果不明：不能透明重放
				record.SendState = sendStateAmbiguous
				record.Category = string(categoryTransport)
				d.attempts = append(d.attempts, record)
				d.sentAny = true
				d.release(account.ID, err.Error())
				failure := upstreamFailure{Category: categoryTransport, Status: http.StatusBadGateway, Message: err.Error()}
				d.lastFail = &failure
				d.deliverFailureState(w, sendStateAmbiguous)
				return outcomeDone
			}
			var privacyErr *PrivacyError
			if errors.As(err, &privacyErr) {
				record.SendState = sendStateNotSent
				record.Category = "privacy_policy_rejected"
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				d.writePrivacyRejected(w)
				return outcomeDone
			}
			var unsupported *bpsUnsupportedError
			if errors.As(err, &unsupported) {
				// BPS 不能承载该请求（发送前，或图片端点拒绝了请求格式）：本请求放弃 BPS，改选原生账号
				record.SendState = sendStateNotSent
				if unsupported.sent {
					record.SendState = sendStateSent
				}
				record.Category = "bps_unsupported"
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				d.bpsDone = true
				body, _ := json.Marshal(map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "basispoints_unsupported_request", "message": unsupported.Error()}})
				d.lastFail = &upstreamFailure{Category: categoryInvalidRequest, Status: http.StatusBadRequest, Code: "basispoints_unsupported_request", Message: unsupported.Error(), Body: body}
				return outcomeDoneRotated
			}
			var imageErr *bpsImageError
			if errors.As(err, &imageErr) {
				// 远程图片无法获取：按调用方请求错误交付，不重试、不换号（上游未收到请求）
				record.SendState = sendStateNotSent
				record.Category = "bps_image_unavailable"
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				kind := "invalid_request_error"
				if imageErr.httpStatus() >= 500 {
					kind = "server_error"
				}
				body, _ := json.Marshal(map[string]any{"error": map[string]any{"type": kind, "code": imageErr.errorCode(), "message": imageErr.Error()}})
				d.lastFail = &upstreamFailure{Category: categoryInvalidRequest, Status: imageErr.httpStatus(), Code: imageErr.errorCode(), Message: imageErr.Error(), Body: body}
				d.deliverFailureState(w, sendStateNotSent)
				return outcomeDone
			}
			if errors.Is(err, errContinuationLost) {
				record.SendState = sendStateNotSent
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				d.writePreviousResponseNotFound(w, sendStateNotSent, "connection_lost")
				return outcomeDone
			}
			record.SendState = sendStateNotSent
			record.Category = string(categoryTransport)
			d.attempts = append(d.attempts, record)
			failure := upstreamFailure{Category: categoryTransport, Status: http.StatusBadGateway, Message: err.Error()}
			d.lastFail = &failure
			// 未发送的建连失败共享 4 次、30 秒预算，耗尽后换号
			if d.connectAt.IsZero() {
				d.connectAt = time.Now()
			}
			d.connects++
			if d.connects < connectFailureRetryLimit && time.Since(d.connectAt) < connectFailureRetryBudget {
				if !sleepContext(ctx, connectRetryDelay(d.connects-1, d.envelope.RequestID)) {
					d.release(account.ID, "")
					d.finishCancelled(w)
					return outcomeDone
				}
				continue
			}
			d.release(account.ID, err.Error())
			if d.bpsAttempt {
				d.bpsFailed(account.ID)
				return outcomeDoneRotated
			}
			d.exclude[account.ID] = true
			d.switches++
			if d.switches > maxAccountSwitches {
				d.deliverFailure(w)
				return outcomeDone
			}
			return outcomeDoneRotated
		}
		d.sentAny = true
		if d.firstByte.IsZero() {
			d.firstByte = time.Now().UTC()
		}
		now := time.Now()
		quotaEvidence := parseQuotaHeaders(resp.Header, now)
		if quota := quotaMap(quotaEvidence); quotaEvidence.Confidence != "unknown" || quotaEvidence.RPMRemaining != nil {
			s.store.UpdateQuota(account.ID, quota)
		}
		record.Status = resp.StatusCode
		record.SendState = sendStateSent
		record.UpstreamRequestID, record.CFRay = upstreamRequestIDs(resp.Header)
		if resp.StatusCode >= 400 {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
			_ = resp.Body.Close()
			failure := classifyHTTPFailure(resp.StatusCode, resp.Header, data, now)
			if d.bpsAttempt {
				failure = classifyBPSHTTPFailure(resp.StatusCode, resp.Header, data, now)
			}
			failure.header = resp.Header.Clone()
			record.Category = string(failure.Category)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			d.lastFail = &failure
			if d.bpsOwnershipRetry(failure) {
				continue
			}
			// 生成前读不了历史密文：账号无过错，缩减历史后同账号重发（不处置账号、不计同号重试）
			if d.recoverEncryptedHistory(failure) {
				continue
			}
			if refreshed, ok := d.bpsRefreshRetry(ctx, account, failure); ok {
				account = refreshed
				continue
			}
			d.dispose(account.ID, failure, now)
			if failure.cyberPolicy() && !failure.bps {
				s.cyberPolicy.record(d.cyberPolicyKey(), account.ID, now)
			}
			if failure.Category == categoryUsageLimit || failure.Category == categoryQuotaExhausted {
				s.readbackQuotaAfterRejection(account.ID)
			}
			next, again := d.afterFailure(ctx, failure, &sameRetries)
			if again {
				continue
			}
			if next == outcomeRotate {
				return outcomeRotate
			}
			d.release(account.ID, string(failure.Category))
			d.deliverFailure(w)
			return outcomeDone
		}
		if !d.envelope.Stream {
			d.commit(w, resp, account, record, nil, attemptStarted)
			return outcomeDone
		}
		preamble, failure, onlyPrelude, err := peekStream(resp)
		if failure != nil && d.bpsAttempt {
			markBPSFailure(failure)
			record.Stage = "stream"
		}
		if failure != nil {
			_ = resp.Body.Close()
			record.Category = string(failure.Category)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			if d.bpsOwnershipRetry(*failure) {
				continue
			}
			// 流内的密文拒绝发生在首个生成内容之前（peekStream 遇失败即返回），同样可同账号缩减后重发
			if d.recoverEncryptedHistory(*failure) {
				d.lastFail = failure
				continue
			}
			if failure.replaySafe() {
				d.lastFail = failure
				d.dispose(account.ID, *failure, now)
				if failure.Category == categoryUsageLimit || failure.Category == categoryQuotaExhausted {
					s.readbackQuotaAfterRejection(account.ID)
				}
				next, again := d.afterFailure(ctx, *failure, &sameRetries)
				if again {
					continue
				}
				if next == outcomeRotate {
					return outcomeRotate
				}
				d.release(account.ID, string(failure.Category))
				d.deliverFailure(w)
				return outcomeDone
			}
			// 不可安全重放的流内失败：按原样交付整段前导与失败事件
			d.attempts = d.attempts[:len(d.attempts)-1]
			d.commit(w, resp, account, record, preamble, attemptStarted)
			return outcomeDone
		}
		// 首个语义输出前上游 WS 断开：同账号有界恢复（CPR 语义边界），耗尽后可回退的请求本会话转 HTTP 再试
		recoverable := err != nil && onlyPrelude && d.wsAttempt && !d.nativeContinuation
		if recoverable && (d.wsRecoveries < wsRecoveryLimit || d.wsRequirement() != wsRequired) {
			_ = resp.Body.Close()
			record.SendState = sendStateAmbiguous
			record.Category = string(categoryTransport)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			s.wsSessions.recordFailure(d.wsSessionKey(), time.Now())
			d.wsRecoveries++
			if d.wsRecoveries > wsRecoveryLimit {
				d.wsDisabled = true
				s.wsSessions.disable(d.wsSessionKey(), time.Now())
			} else if !sleepContext(ctx, wsRecoveryDelay(d.wsRecoveries)) {
				d.release(account.ID, "")
				d.finishCancelled(w)
				return outcomeDone
			}
			continue
		}
		if err != nil && len(preamble) == 0 {
			_ = resp.Body.Close()
			record.SendState = sendStateAmbiguous
			record.Category = string(categoryTransport)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			d.release(account.ID, err.Error())
			failure := upstreamFailure{Category: categoryTransport, Status: http.StatusBadGateway, Message: err.Error()}
			d.lastFail = &failure
			d.deliverFailureState(w, sendStateAmbiguous)
			return outcomeDone
		}
		d.commit(w, resp, account, record, preamble, attemptStarted)
		return outcomeDone
	}
	return outcomeRotate
}

// outcomeDoneRotated 表示账号已在 runAccount 内释放并排除，外层只需继续选号。
const outcomeDoneRotated accountOutcome = 2

// afterFailure 决定同号重试（again=true）、换号（outcomeRotate）或交付错误（outcomeDone）。
// 401 不在请求内刷新重放（CPR OpenAI 无请求内凭据恢复）：账号按 Dispose 处置，可安全重放时换号。
func (d *dispatchRun) afterFailure(ctx context.Context, failure upstreamFailure, sameRetries *int) (accountOutcome, bool) {
	s := d.server
	// 客户端重试抑制只针对 503 server_error（CPR is_return_error_retry），容量拒绝照常同号退避
	suppressed := d.retrySuppressed && failure.isRetryableServerError()
	if delay, ok := failure.sameAccountRetryDelay(*sameRetries, s.maxRetryAfter()); ok && !suppressed && !d.retryBudgetSpent(delay) {
		*sameRetries++
		if sleepContext(ctx, delay) {
			return outcomeDone, true
		}
		return outcomeDone, false
	}
	if failure.rotatesAccount() && ctx.Err() == nil {
		return outcomeRotate, false
	}
	return outcomeDone, false
}

// maxRetryAfter 是接受的单次 Retry-After 等待上限（对齐 CPR 0ff1a729）：缺省 240 秒；
// 显式 0 表示不接受正数等待，服务器建议超过上限时不截短，改走换号或原错误出口；负数视为未配置。
func (s *Server) maxRetryAfter() time.Duration {
	if s.cfg.MaxRetryAfterSec < 0 {
		return defaultMaxRetryAfter
	}
	return time.Duration(s.cfg.MaxRetryAfterSec) * time.Second
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// send 构造并发送一次上游请求；wrote 表示请求是否已写出（用于区分未发送与发送不明）。
func (d *dispatchRun) send(ctx context.Context, account Account) (*http.Response, bool, error) {
	if d.envelope.Operation == "live" {
		return d.sendLive(ctx, account)
	}
	if d.bpsAttempt {
		return d.sendBPS(ctx, account)
	}
	if d.nativeContinuation || d.useWebSocket(account) {
		d.wsAttempt = true
		resp, wrote, err := d.sendWS(ctx, account)
		if !errors.Is(err, errWSFallback) {
			return resp, wrote, err
		}
		// 必须走 WS 的请求不回退 HTTP，交回客户端重放（CPR ContinuationUnavailable → ClientReplayRequired）
		if d.nativeContinuation || d.wsRequirement() == wsRequired {
			return nil, false, errContinuationLost
		}
		// 快路径未命中只让本次尝试走 HTTP；其余回退原因在本请求内不再尝试 WS
		if !errors.Is(err, errWSFastPathMiss) {
			d.wsDisabled = true
		}
	}
	d.wsAttempt = false
	return d.sendHTTP(ctx, account)
}

func (d *dispatchRun) sendHTTP(ctx context.Context, account Account) (*http.Response, bool, error) {
	s := d.server
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) }}
	body, state, affinity := d.prepareAttempt(account)
	d.affinity = nil
	d.attemptState = state
	routingHint := codexRoutingHint(body)
	// OAuth 推理请求遵循 Codex 压缩合同（zstd level 3）；API Key 与 Search/Images 使用普通 JSON
	compressed := account.APIKey == "" && (d.envelope.Operation == "responses" || d.envelope.Operation == "chat")
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodPost, d.target, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if d.envelope.Operation == "responses" || d.envelope.Operation == "chat" {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "text/event-stream, application/json")
	}
	if compressed {
		req.Header.Set("Content-Encoding", "zstd")
	}
	// openai-beta 只属于 WS 握手，HTTP 不发送（CPR 头契约，已在入站黑名单中）
	for name, value := range d.upstreamInboundHeaders() {
		req.Header.Set(name, value)
	}
	if hint := routingHint; hint != "" {
		req.Header.Set("x-codex-routing-hint", hint)
	}
	scopeCorrelationHeaders(req.Header, account.InstallationID)
	applyAttemptHeaders(req.Header, account, state)
	applyProfileIdentity(req.Header, account, d.profile)
	affinity.apply(d.target, req.Header)
	// 隐私规则在全部宿主头与正文投影完成后、压缩前执行
	body, err = d.privacy.applyBody(ctx, body, req.Header)
	if err != nil {
		return nil, false, err
	}
	if compressed {
		if body, err = zstdEncode(body); err != nil {
			return nil, false, err
		}
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	client, err := s.clientFor(account)
	if err != nil {
		return nil, false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, wrote.Load(), err
	}
	return resp, true, nil
}

// peekStream 读取可透明重试的前导事件；遇到首个实质事件即停止。返回已读字节、流内失败（若在前导内出现）。
// peekStream 读取提交点之前的前导；onlyPrelude 表示到目前为止只有可替换前导（断线时可同账号恢复）。
func peekStream(resp *http.Response) ([]byte, *upstreamFailure, bool, error) {
	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	resp.Body = readCloser{Reader: reader, Closer: resp.Body}
	var buffered bytes.Buffer
	events := 0
	onlyPrelude := true
	var dataLines []string
	for buffered.Len() < sseFailurePreambleMaxBytes && events < preambleEventLimit {
		line, err := reader.ReadString('\n')
		buffered.WriteString(line)
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(trimmed, "data:") {
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(trimmed, "data:")))
		}
		if trimmed == "" && len(dataLines) > 0 {
			events++
			payload := strings.Join(dataLines, "\n")
			dataLines = nil
			var event map[string]any
			if json.Unmarshal([]byte(payload), &event) != nil {
				return buffered.Bytes(), nil, false, nil
			}
			eventType, _ := event["type"].(string)
			if eventType == "response.failed" || eventType == "error" {
				failure := classifySSEFailure(event)
				return buffered.Bytes(), &failure, false, nil
			}
			onlyPrelude = onlyPrelude && replaceablePrelude(eventType, event)
			// 只有生成内容或终态才构成提交点（对齐 CPR：未归一成输出的事件不触发交付）；
			// 上游在失败前插入的结构事件（如 output_item.added 的空推理项）继续缓冲，失败仍可重试
			if !replayablePreambleEvents[eventType] && (terminalStreamEvents[eventType] || generatedContentEvent(event)) {
				return buffered.Bytes(), nil, false, nil
			}
		}
		if err != nil {
			return buffered.Bytes(), nil, onlyPrelude, err
		}
	}
	return buffered.Bytes(), nil, false, nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// commit 写出响应头（提交点）与剩余正文，记录 usage/额度并写 Receipt。
func (d *dispatchRun) commit(w http.ResponseWriter, resp *http.Response, account Account, record attemptRecord, preamble []byte, attemptStarted time.Time) {
	s := d.server
	defer resp.Body.Close()
	if etag := resp.Header.Get("x-models-etag"); etag != "" {
		s.observeModelsETag(etag)
	}
	// 上游 WS：前导里 metadata 帧声明的 turn-state 交给客户端（复用连接没有握手头可用）
	wsStream := wsBodyOf(resp.Body)
	if wsStream != nil {
		if _, state := wsStream.metadata(); state != "" && resp.Header.Get("x-codex-turn-state") == "" {
			resp.Header.Set("x-codex-turn-state", state)
		}
	}
	for key, values := range resp.Header {
		if safeResponseHeader(key) && !isCodexQuotaHeader(key) {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
	}
	d.attempts = append(d.attempts, record)
	w.Header().Set("X-Kin-Gateway-Account", account.ID)
	w.Header().Set("X-Kin-Gateway-Credential-Revision", fmt.Sprint(account.CredentialRevision))
	w.Header().Set("X-Kin-Gateway-Projection-Revision", fmt.Sprint(account.ProjectionRevision))
	w.Header().Set(authModeHeader, d.authMode())
	if path := d.upstreamPath(); path != "" {
		w.Header().Set(upstreamPathHeader, path)
	}
	if wsStream != nil {
		w.Header().Set(upstreamTransportHeader, "websocket")
	} else {
		w.Header().Set(upstreamTransportHeader, "http")
	}
	w.Header().Set(sendStateHeader, sendStateSent)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	if session := d.outboundSession(account); session != "" {
		w.Header().Set(outboundSessionHeader, session)
	}
	if d.sentServiceTier != "" {
		w.Header().Set("X-Kin-Gateway-Service-Tier", d.sentServiceTier)
	}
	if d.preCommit != nil {
		d.preCommit.Stop()
	}
	if resp.StatusCode < 400 {
		s.cyberPolicy.clear(d.cyberPolicyKey())
	}
	w.WriteHeader(resp.StatusCode)
	firstOutput := time.Since(attemptStarted)
	observer := newSSEObserver(d.envelope.Stream)
	observer.collectOutput = d.bpsAttempt
	turnState := resp.Header.Get("x-codex-turn-state")
	d.rememberTurnState(account, turnState)
	if turnState == "" {
		turnState = d.attemptState.turnState
	}
	observer.onResponseID = func(id string) {
		s.guardian.remember(d.envelope.ClientScope, id, d.inboundHeader("session-id"), responseRecord{
			capturedAt: time.Now(), account: account.ID, affinity: d.affinity, turnState: turnState, turnID: d.inboundHeader("x-codex-turn-id"),
		})
	}
	var copyErr error
	if d.envelope.Stream {
		if len(preamble) > 0 {
			observer.Write(preamble)
			if _, err := w.Write(preamble); err != nil {
				copyErr = err
			} else if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if copyErr == nil {
			_, copyErr = copyFlushing(w, io.TeeReader(resp.Body, observer))
		}
		observer.Close()
	} else {
		var responseBody []byte
		responseBody, copyErr = io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		if copyErr == nil {
			_, copyErr = w.Write(responseBody)
			observer.observeJSON(responseBody)
		}
	}
	d.attempts[len(d.attempts)-1].DurationMS = time.Since(attemptStarted).Milliseconds()
	if body, ok := resp.Body.(*bpsBody); ok && observer.usage == nil {
		// BPS 流中断、取消或失败事件未带用量：回执按转换累计的已消耗用量结算（标为 partial）
		if usage := body.finalUsage(); len(usage) > 0 {
			observer.usage, observer.usagePartial = usage, true
		}
	}
	terminal := terminalCompleted
	errorCode := ""
	switch {
	case copyErr != nil && s.takeDrainForced(d.envelope.Dispatch):
		terminal = terminalCancelled
		errorCode = "drain_deadline"
	case copyErr != nil:
		terminal = terminalAmbiguous
		errorCode = "stream_copy_error"
	case d.envelope.Stream && observer.failed:
		terminal = terminalUpstreamError
		errorCode = observer.failureCategory
	case d.envelope.Stream && !observer.terminal:
		terminal = terminalIncomplete
		errorCode = "stream_incomplete"
	}
	if terminal == terminalCompleted && resp.StatusCode < 400 {
		d.recordRouteHistory(observer)
		if d.bpsAttempt {
			s.saveBPSContinuation(d, account, observer)
		}
		s.clientRetry.clear(d.clientTurn)
		if d.bpsAttempt {
			s.store.RecordBPSSuccess(account.ID, d.envelope.Model)
			s.finishBPSImages(context.Background(), d.bpsImagePlan, d.bpsImageWindow)
		} else {
			s.store.RecordSuccess(account.ID)
			s.store.RecordFeedback(account.ID, feedbackSucceeded, firstOutput)
			if d.countable {
				s.store.RecordProtectionSuccess(account.ID, d.protectionVersion)
			}
		}
	}
	if observer.failed && observer.failure != nil {
		d.dispose(account.ID, *observer.failure, time.Now())
	}
	streamQuota := observer.rateLimits
	if len(observer.rateLimits) > 0 {
		s.store.MergeQuota(account.ID, observer.rateLimits)
	}
	// 上游 WS 的 codex.rate_limits 不转发给调用方，由 wsBody 解析后在这里并入额度；终态前断开的诊断经 trailer 交给控制面
	if wsStream != nil {
		if limits, _ := wsStream.metadata(); len(limits) > 0 {
			s.store.MergeQuota(account.ID, limits)
			streamQuota = mergeQuotaWindows(streamQuota, limits)
		}
		if diagnostic := wsStream.closeDiagnostic(); diagnostic != "" {
			w.Header().Set(http.TrailerPrefix+gatewayDiagnosticTrailer, diagnostic)
		}
	}
	releaseErr := ""
	if copyErr != nil {
		releaseErr = copyErr.Error()
	}
	d.release(account.ID, releaseErr)
	if d.envelope.Operation == "live" && resp.StatusCode < 300 {
		// 通话引导成功：Location 中的 call id 钉住创建账号，供 sideband 与 hangup 使用
		if callID := callIDFromLocation(resp.Header.Get("Location")); callID != "" {
			s.live.register(callID, account.ID, d.envelope.ClientScope, d.envelope.Model, d.profile)
		}
	}
	d.writeReceiptQuota(account, resp.StatusCode, terminal, errorCode, sendStateSent, resp.Header, observer, streamQuota)
}

// deliverFailure 交付最后一次上游拒绝（已投影为客户端可消费形态）。
func (d *dispatchRun) deliverFailure(w http.ResponseWriter) {
	state := sendStateNotSent
	if d.sentAny {
		state = sendStateSent
	}
	d.deliverFailureState(w, state)
}

func (d *dispatchRun) deliverFailureState(w http.ResponseWriter, state string) {
	failure := d.lastFail
	if failure == nil {
		failure = &upstreamFailure{Category: categoryUnavailable, Status: http.StatusServiceUnavailable}
	}
	if len(d.attempts) > 0 && failure.isRetryableServerError() {
		d.server.clientRetry.record(d.clientTurn, time.Now())
	}
	status, body := failure.clientProjection()
	if failure.header != nil {
		// 上游失败响应下发的 turn-state 同样交给客户端并记录归属证明（CPR 790f3147）
		for _, key := range []string{"Retry-After", "X-Request-Id", "x-codex-turn-state"} {
			if value := failure.header.Get(key); value != "" {
				w.Header().Set(key, value)
			}
		}
		if state != sendStateNotSent {
			d.rememberTurnState(d.lastAcct, failure.header.Get("x-codex-turn-state"))
		}
	}
	// 全池过载停止：提示至少 3 秒后重试（上游给出更长的等待时沿用上游值）
	if d.poolOverloadStop {
		if seconds, err := strconv.Atoi(strings.TrimSpace(w.Header().Get("Retry-After"))); err != nil || seconds < int(poolOverloadRetryAfter/time.Second) {
			w.Header().Set("Retry-After", strconv.Itoa(int(poolOverloadRetryAfter/time.Second)))
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(sendStateHeader, state)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	w.Header().Set(errorCategoryHeader, string(failure.Category))
	if detail := upstreamErrorJSON(failure); detail != "" {
		w.Header().Set(upstreamErrorHeader, detail)
	}
	if d.lastAcct.ID != "" && state != sendStateNotSent {
		if session := d.outboundSession(d.lastAcct); session != "" {
			w.Header().Set(outboundSessionHeader, session)
		}
		w.Header().Set("X-Kin-Gateway-Account", d.lastAcct.ID)
		w.Header().Set("X-Kin-Gateway-Credential-Revision", fmt.Sprint(d.lastAcct.CredentialRevision))
		w.Header().Set(authModeHeader, d.authMode())
		if path := d.upstreamPath(); path != "" {
			w.Header().Set(upstreamPathHeader, path)
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
	if d.sentAny {
		terminal := terminalUpstreamError
		if state == sendStateAmbiguous {
			terminal = terminalAmbiguous
		}
		d.writeReceipt(d.lastAcct, failure.Status, terminal, string(failure.Category), state, failure.header, nil)
	}
}

func (d *dispatchRun) pinned() bool { return d.envelope.Scope.RuntimeAccountID != "" }

// continuation：钉住原账号且原始正文带 previous_response_id（重放完整历史时仍按续接处理）。
// 账号测试等只指定账号的请求不是续接，额度耗尽按原错误交付。
func (d *dispatchRun) continuation() bool {
	return d.pinned() && previousResponseID(d.envelope.Body) != ""
}

// deliverContinuationFailure 对齐 CPR：原账号额度耗尽且尚未交付输出时返回 400
// previous_response_not_found，让客户端去掉 previous_response_id 携带完整历史重试；
// 其他失败按原错误交付。
func (d *dispatchRun) deliverContinuationFailure(w http.ResponseWriter) {
	if !d.continuation() || d.lastFail == nil || !(d.lastFail.Category == categoryUsageLimit || d.lastFail.Category == categoryQuotaExhausted) {
		d.deliverFailure(w)
		return
	}
	d.writePreviousResponseNotFound(w, sendStateSent, "quota_exhausted")
}

// writePrivacyRejected：隐私规则按 reject_request 拒绝，请求未发送、不重试，不回显规则内容。
func (d *dispatchRun) writePrivacyRejected(w http.ResponseWriter) {
	w.Header().Set(sendStateHeader, sendStateNotSent)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	writePrivacyRejectedBody(w)
	if d.sentAny {
		d.writeReceipt(d.lastAcct, http.StatusBadRequest, terminalUpstreamError, "privacy_policy_rejected", sendStateNotSent, nil, nil)
	}
}

func writePrivacyRejectedBody(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "privacy_policy_rejected", "message": "A gateway privacy rule could not process this request."}})
}

// writePreviousResponseNotFound 交回客户端带完整历史重放；reason 是续接不可用原因（写入诊断头）。
func (d *dispatchRun) writePreviousResponseNotFound(w http.ResponseWriter, state, reason string) {
	w.Header().Set(continuationReasonHeader, reason)
	w.Header().Set(sendStateHeader, state)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	if reason == "quota_exhausted" {
		w.Header().Set(errorCategoryHeader, string(categoryUsageLimit))
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "previous_response_not_found", "param": "previous_response_id", "message": "Previous response is no longer available on its account; retry without previous_response_id and include the full conversation."}})
	if d.sentAny {
		d.writeReceipt(d.lastAcct, http.StatusBadRequest, terminalUpstreamError, "previous_response_not_found", state, nil, nil)
	}
}

// finishWithoutAccount：范围内无可用账号。尚未发送任何请求时告诉控制面可换实例。
func (d *dispatchRun) finishWithoutAccount(w http.ResponseWriter, err error) {
	if d.continuation() && errors.Is(err, ErrUsageLimitExhausted) {
		d.writePreviousResponseNotFound(w, sendStateNotSent, "quota_exhausted")
		return
	}
	if errors.Is(err, ErrContinuationOwnerChanged) {
		w.Header().Set(continuationReasonHeader, "scope_unavailable")
		w.Header().Set(sendStateHeader, sendStateNotSent)
		w.Header().Set(attemptsHeader, d.attemptsJSON())
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "previous_response_not_found", "param": "previous_response_id", "message": "Previous response is unavailable in the selected upstream scope; retry without previous_response_id and include the full conversation."}})
		return
	}
	if errors.Is(err, ErrSessionPolicyRestricted) {
		w.Header().Set(sendStateHeader, sendStateNotSent)
		w.Header().Set(attemptsHeader, d.attemptsJSON())
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "cyber_policy", "message": ErrSessionPolicyRestricted.Error()}})
		return
	}
	if d.lastFail != nil {
		if d.pinned() {
			d.deliverContinuationFailure(w)
			return
		}
		d.deliverFailure(w)
		return
	}
	w.Header().Set(sendStateHeader, sendStateNotSent)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	if errors.Is(err, ErrAccountCapacityUnavailable) {
		w.Header().Set(errorCategoryHeader, "account_capacity_unavailable")
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]any{"type": "server_error", "code": "account_capacity_unavailable", "message": err.Error()}})
		return
	}
	if errors.Is(err, ErrQueueFull) || errors.Is(err, ErrQueueTimeout) {
		// 本地容量拒绝，不是上游限流（CPR concurrency_queue_full / concurrency_queue_timeout）
		code := "concurrency_queue_full"
		if errors.Is(err, ErrQueueTimeout) {
			code = "concurrency_queue_timeout"
		}
		w.Header().Set(errorCategoryHeader, code)
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]any{"type": "rate_limit_error", "code": code, "message": err.Error()}})
		return
	}
	if errors.Is(err, ErrUsageLimitExhausted) {
		w.Header().Set(errorCategoryHeader, string(categoryUsageLimit))
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": map[string]any{"type": "usage_limit_reached", "code": "usage_limit_reached", "message": "All eligible Codex accounts have reached their usage limit."}})
		return
	}
	writeError(w, http.StatusServiceUnavailable, "gateway_worker_no_account", err.Error())
}

func (d *dispatchRun) finishCancelled(w http.ResponseWriter) {
	state := sendStateNotSent
	if d.sentAny {
		state = sendStateAmbiguous
	}
	w.Header().Set(sendStateHeader, state)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	code := "client_cancelled"
	status := 499
	if d.server.takeDrainForced(d.envelope.Dispatch) {
		code, status = "drain_deadline", http.StatusServiceUnavailable
	}
	writeError(w, status, code, "request cancelled")
	if d.sentAny {
		d.writeReceipt(d.lastAcct, 0, terminalCancelled, code, state, nil, nil)
	}
}

func (d *dispatchRun) attemptsJSON() string {
	data, _ := json.Marshal(d.attempts)
	return string(data)
}

func (d *dispatchRun) writeReceipt(account Account, status int, terminal, errorCode, sendState string, header http.Header, observer *sseObserver) {
	d.writeReceiptQuota(account, status, terminal, errorCode, sendState, header, observer, nil)
}

// writeReceiptQuota 写回执；streamQuota 为本次流内 codex.rate_limits 观测，与响应头额度合并后进入回执。
func (d *dispatchRun) writeReceiptQuota(account Account, status int, terminal, errorCode, sendState string, header http.Header, observer *sseObserver, streamQuota map[string]any) {
	s := d.server
	usageConfidence := "unknown"
	var usage any
	quota, quotaConfidence := receiptQuota(header, streamQuota, time.Now())
	if observer != nil && observer.usage != nil {
		usage = observer.usage
		usageConfidence = "complete"
		if observer.usagePartial {
			usageConfidence = "partial"
		}
		// 结算按实际发送的档位（分组 Fast 策略可能改写）；上游 usage 不含档位时补上
		if values, ok := usage.(map[string]any); ok && d.sentServiceTier != "" {
			if _, present := values["service_tier"]; !present {
				copied := make(map[string]any, len(values)+1)
				for key, value := range values {
					copied[key] = value
				}
				copied["service_tier"] = d.sentServiceTier
				usage = copied
			}
		}
	} else if quotaConfidence != "unknown" {
		usageConfidence = "partial"
	}
	firstByte := d.firstByte
	if firstByte.IsZero() {
		firstByte = d.startedAt
	}
	receipt := map[string]any{
		"receipt_id": "receipt_" + d.envelope.Dispatch, "dispatch_id": d.envelope.Dispatch, "request_id": d.envelope.RequestID, "operation": d.envelope.Operation, "settings_revision": d.envelope.Scheduling.SettingsRevision,
		"attempt_id": d.envelope.AttemptID, "gateway_instance_id": s.cfg.InstanceID, "sequence": atomic.AddInt64(&s.receiptSequence, 1),
		"runtime_account_id": account.ID, "credential_revision": account.CredentialRevision, "projection_revision": account.ProjectionRevision,
		"send_state": sendState, "terminal_state": terminal, "upstream_status": status, "upstream_model": d.envelope.Model,
		"usage_confidence": usageConfidence, "usage": usage, "quota": quota, "quota_confidence": quotaConfidence,
		"headers": safeReceiptHeaders(header), "attempts": d.attempts,
		"started_at": d.startedAt.Format(time.RFC3339Nano), "first_byte_at": firstByte.Format(time.RFC3339Nano), "finished_at": time.Now().UTC().Format(time.RFC3339Nano),
	}
	if observer != nil && observer.responseModel != "" {
		receipt["response_model"] = observer.responseModel
	}
	if kind := requestKind(d.body); kind != "" {
		receipt["request_kind"] = kind
	}
	if errorCode != "" {
		receipt["error_code"] = errorCode
	}
	_ = s.writeReceipt(d.envelope.Dispatch, receipt)
}

// sseObserver 逐行观察已交付的流：保留最后的 usage、终态、流内失败与 codex.rate_limits，
// 不受响应总长度限制（替代旧的 4MB 头部截取）。
type sseObserver struct {
	stream          bool
	partial         []byte
	overflow        bool
	dataLines       []string
	usage           any
	terminal        bool
	failed          bool
	failure         *upstreamFailure
	failureCategory string
	responseModel   string
	rateLimits      map[string]any
	responseID      string
	onResponseID    func(string)
	// historyKeys 是输出项中密文的摘要（历史来源锁定，route_provenance.go）
	historyKeys []string
	// usagePartial：用量来自中断的 BPS 转换累计值，而不是终态事件
	usagePartial bool
	// collectOutput 时保存交付的输出项（BPS 续接快照，bps_continuation.go）
	collectOutput   bool
	doneItems       []json.RawMessage
	completedOutput []json.RawMessage
	outputBytes     int
}

// outputItems 优先取终态 response.output，终态未携带输出时用逐项完成事件。
func (o *sseObserver) outputItems() []json.RawMessage {
	if o.outputBytes > bpsContinuationMaxBytes {
		return nil
	}
	if len(o.completedOutput) > 0 {
		return o.completedOutput
	}
	return o.doneItems
}

func (o *sseObserver) keepOutput(items ...any) []json.RawMessage {
	var kept []json.RawMessage
	for _, item := range items {
		raw, err := json.Marshal(item)
		if err != nil {
			continue
		}
		o.outputBytes += len(raw)
		kept = append(kept, raw)
	}
	return kept
}

func newSSEObserver(stream bool) *sseObserver { return &sseObserver{stream: stream} }

func (o *sseObserver) Write(data []byte) (int, error) {
	n := len(data)
	for len(data) > 0 {
		index := bytes.IndexByte(data, '\n')
		if index < 0 {
			if !o.overflow {
				if len(o.partial)+len(data) > sseLineLimit {
					o.overflow = true
					o.partial = o.partial[:0]
				} else {
					o.partial = append(o.partial, data...)
				}
			}
			break
		}
		if !o.overflow {
			o.partial = append(o.partial, data[:index]...)
			o.line(string(o.partial))
		}
		o.partial = o.partial[:0]
		o.overflow = false
		data = data[index+1:]
	}
	return n, nil
}

func (o *sseObserver) Close() {
	if len(o.partial) > 0 && !o.overflow {
		o.line(string(o.partial))
	}
	o.line("")
}

func (o *sseObserver) line(raw string) {
	line := strings.TrimRight(raw, "\r")
	if strings.HasPrefix(line, "data:") {
		o.dataLines = append(o.dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		return
	}
	if line != "" || len(o.dataLines) == 0 {
		return
	}
	payload := strings.Join(o.dataLines, "\n")
	o.dataLines = nil
	if payload == "[DONE]" {
		return
	}
	var event map[string]any
	if json.Unmarshal([]byte(payload), &event) != nil {
		return
	}
	o.observeEvent(event)
}

func (o *sseObserver) observeEvent(event map[string]any) {
	eventType, _ := event["type"].(string)
	if terminalStreamEvents[eventType] {
		o.terminal = true
	}
	if response, ok := event["response"].(map[string]any); ok {
		if usage, ok := response["usage"].(map[string]any); ok && len(usage) > 0 {
			o.usage = usage
		}
		if model, ok := response["model"].(string); ok && model != "" {
			o.responseModel = model
		}
		if id, ok := response["id"].(string); ok && id != "" && o.responseID == "" {
			o.responseID = id
			if o.onResponseID != nil {
				o.onResponseID(id)
			}
		}
	}
	if usage, ok := event["usage"].(map[string]any); ok && len(usage) > 0 {
		o.usage = usage
	}
	if item, ok := event["item"].(map[string]any); ok && eventType == "response.output_item.done" {
		collectEncrypted(item, o.addHistoryKey)
		if o.collectOutput && o.outputBytes <= bpsContinuationMaxBytes {
			o.doneItems = append(o.doneItems, o.keepOutput(item)...)
		}
	}
	if response, ok := event["response"].(map[string]any); ok && terminalStreamEvents[eventType] {
		o.observeOutput(response["output"])
		if items, _ := response["output"].([]any); o.collectOutput && len(items) > 0 && eventType == "response.completed" {
			o.completedOutput = o.keepOutput(items...)
		}
	}
	if eventType == "response.failed" || eventType == "error" {
		failure := classifySSEFailure(event)
		o.failed = true
		o.failure = &failure
		o.failureCategory = string(failure.Category)
	}
	if eventType == "codex.rate_limits" {
		if limits := parseRateLimitsEvent(event, time.Now()); len(limits) > 0 {
			o.rateLimits = limits
		}
	}
}

func (o *sseObserver) observeJSON(body []byte) {
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) != nil {
		return
	}
	if usage, ok := parsed["usage"].(map[string]any); ok && len(usage) > 0 {
		o.usage = usage
	}
	if model, ok := parsed["model"].(string); ok {
		o.responseModel = model
	}
	if id, ok := parsed["id"].(string); ok && o.responseID == "" {
		o.responseID = id
	}
	o.observeOutput(parsed["output"])
	o.terminal = true
}

func (o *sseObserver) observeOutput(output any) {
	items, _ := output.([]any)
	for _, raw := range items {
		if item, ok := raw.(map[string]any); ok {
			collectEncrypted(item, o.addHistoryKey)
		}
	}
}

func (o *sseObserver) addHistoryKey(key string) {
	if len(o.historyKeys) >= provenanceMaxKeys {
		return
	}
	for _, existing := range o.historyKeys {
		if existing == key {
			return
		}
	}
	o.historyKeys = append(o.historyKeys, key)
}

// outboundSession 是发往上游的 session-id：OAuth 账号按安装身份映射为稳定 UUID（correlation.go），
// API Key 账号原样发送；调用方没有会话时为空。
func (d *dispatchRun) outboundSession(account Account) string {
	session := d.inboundHeader("session-id")
	if session == "" || account.InstallationID == "" {
		return session
	}
	return scopedID(account.InstallationID, session)
}

// generatedContentEvent 判断事件是否已携带生成内容（与控制面 stream-timing.mjs 的首 Token 判定一致）：
// 非空增量、带文本/拒答/工具名或参数的内容块与输出项。
func generatedContentEvent(event map[string]any) bool {
	eventType, _ := event["type"].(string)
	switch {
	case strings.HasPrefix(eventType, "response.") && strings.HasSuffix(eventType, ".delta"):
		delta, _ := event["delta"].(string)
		return delta != ""
	case eventType == "response.content_part.added" || eventType == "response.content_part.done":
		return hasGeneratedContent(event["part"])
	case eventType == "response.output_item.added" || eventType == "response.output_item.done":
		item, _ := event["item"].(map[string]any)
		if hasGeneratedContent(item) {
			return true
		}
		content, _ := item["content"].([]any)
		for _, part := range content {
			if hasGeneratedContent(part) {
				return true
			}
		}
	}
	return false
}

func hasGeneratedContent(value any) bool {
	block, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, key := range []string{"text", "thinking", "refusal"} {
		if text, _ := block[key].(string); text != "" {
			return true
		}
	}
	kind, _ := block["type"].(string)
	if kind == "function_call" || kind == "custom_tool_call" || strings.HasSuffix(kind, "tool_use") {
		for _, key := range []string{"name", "arguments", "input"} {
			if text, _ := block[key].(string); text != "" {
				return true
			}
		}
	}
	return false
}

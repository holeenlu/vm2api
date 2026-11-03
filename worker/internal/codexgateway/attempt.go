package codexgateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"time"
)

const (
	sendStateHeader       = "X-Kin-Gateway-Send-State"
	attemptsHeader        = "X-Kin-Gateway-Attempts"
	errorCategoryHeader   = "X-Kin-Gateway-Error-Category"
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

// 前导事件交付后仍可透明重试（对齐 CPR：created、in_progress、codex.rate_limits）。
var replayablePreambleEvents = map[string]bool{"response.created": true, "response.in_progress": true, "codex.rate_limits": true}

var terminalStreamEvents = map[string]bool{"response.completed": true, "response.done": true, "response.failed": true, "response.incomplete": true}

type attemptRecord struct {
	Account            string `json:"account"`
	CredentialRevision int64  `json:"credential_revision,omitempty"`
	Status             int    `json:"status,omitempty"`
	Category           string `json:"category,omitempty"`
	SendState          string `json:"send_state"`
	DurationMS         int64  `json:"duration_ms"`
}

type dispatchRun struct {
	server   *Server
	envelope Envelope
	target   string
	body     []byte
	guardian bool
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

	attempts  []attemptRecord
	exclude   map[string]bool
	switches  int
	connects  int
	connectAt time.Time
	lastFail  *upstreamFailure
	lastAcct  Account
	sentAny   bool
	firstByte time.Time
	startedAt time.Time
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
}

// execute 在提交（WriteHeader）前完成同账号重试、401 刷新恢复与换号；提交后不再重试。
func (d *dispatchRun) execute(ctx context.Context, w http.ResponseWriter) {
	s := d.server
	d.exclude = map[string]bool{}
	d.startedAt = time.Now().UTC()
	model := d.envelope.Model
	for len(d.attempts) < maxTotalAttempts {
		account, err := s.store.Acquire(ctx, selectRequest{Scope: d.envelope.Scope, Model: model, Operation: d.envelope.Operation, Exclude: d.exclude, Guardian: d.guardian, Policy: d.envelope.Scheduling}, &d.waitDeadline)
		if err != nil {
			if ctx.Err() != nil {
				d.finishCancelled(w)
				return
			}
			d.finishWithoutAccount(w, err)
			return
		}
		if needsRefreshBeforeSend(account, time.Now()) {
			refreshed, refreshErr := s.refreshNow(ctx, account.ID)
			if refreshErr != nil {
				// 刷新失败的账号本次排除；不计入换号次数（与 CPR 选号阶段过滤相同）
				d.release(account.ID, "credential_refresh_failed")
				d.exclude[account.ID] = true
				if ctx.Err() != nil {
					d.finishCancelled(w)
					return
				}
				continue
			}
			account = withRuntime(refreshed, account)
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
			d.exclude[account.ID] = true
			d.switches++
			if d.switches > maxAccountSwitches {
				d.deliverFailure(w)
				return
			}
		}
	}
	d.deliverFailure(w)
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
}

// runAccount 在单个账号上执行（含同号退避重试和 401 刷新），返回是否需要换号。
func (d *dispatchRun) runAccount(ctx context.Context, w http.ResponseWriter, account Account) accountOutcome {
	s := d.server
	sameRetries := 0
	refreshed := false
	d.lastAcct = account
	for len(d.attempts) < maxTotalAttempts {
		attemptStarted := time.Now()
		d.protectionVersion = s.store.ProtectionVersion(account.ID)
		resp, wrote, err := d.send(ctx, account)
		record := attemptRecord{Account: account.ID, CredentialRevision: account.CredentialRevision}
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
			if errors.Is(err, errContinuationLost) {
				record.SendState = sendStateNotSent
				d.attempts = append(d.attempts, record)
				d.release(account.ID, "")
				d.writePreviousResponseNotFound(w, sendStateNotSent)
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
				if !sleepContext(ctx, time.Duration(d.connects)*200*time.Millisecond) {
					d.release(account.ID, "")
					d.finishCancelled(w)
					return outcomeDone
				}
				continue
			}
			d.release(account.ID, err.Error())
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
		if resp.StatusCode >= 400 {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
			_ = resp.Body.Close()
			failure := classifyHTTPFailure(resp.StatusCode, resp.Header, data, now)
			failure.header = resp.Header.Clone()
			record.Category = string(failure.Category)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			d.lastFail = &failure
			s.store.Dispose(account.ID, d.envelope.Model, failure, now)
			d.feedback(account.ID, failure)
			d.protectFailure(account.ID, failure)
			next, again := d.afterFailure(ctx, &account, failure, &sameRetries, &refreshed)
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
		preamble, failure, err := peekStream(resp)
		if failure != nil {
			_ = resp.Body.Close()
			record.Category = string(failure.Category)
			record.DurationMS = time.Since(attemptStarted).Milliseconds()
			d.attempts = append(d.attempts, record)
			if failure.replaySafe() {
				d.lastFail = failure
				s.store.Dispose(account.ID, d.envelope.Model, *failure, now)
				d.feedback(account.ID, *failure)
				d.protectFailure(account.ID, *failure)
				next, again := d.afterFailure(ctx, &account, *failure, &sameRetries, &refreshed)
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
func (d *dispatchRun) afterFailure(ctx context.Context, account *Account, failure upstreamFailure, sameRetries *int, refreshed *bool) (accountOutcome, bool) {
	s := d.server
	if failure.Category == categoryCredentialExpired && !*refreshed && refreshable(*account) {
		*refreshed = true
		if updated, err := s.refreshNow(ctx, account.ID); err == nil {
			*account = withRuntime(updated, *account)
			d.lastAcct = *account
			return outcomeDone, true
		}
	}
	if delay, ok := failure.sameAccountRetryDelay(*sameRetries, s.maxRetryAfter()); ok {
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

func (s *Server) maxRetryAfter() time.Duration {
	if s.cfg.MaxRetryAfterSec > 0 {
		return time.Duration(s.cfg.MaxRetryAfterSec) * time.Second
	}
	return defaultMaxRetryAfter
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
	if d.nativeContinuation || d.useWebSocket(account) {
		resp, wrote, err := d.sendWS(ctx, account)
		if !errors.Is(err, errWSFallback) {
			return resp, wrote, err
		}
		if d.nativeContinuation {
			return nil, wrote, errContinuationLost
		}
		d.wsDisabled = true
	}
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
	for key, value := range d.envelope.Headers {
		// openai-beta 只属于 WS 握手，HTTP 不发送（CPR 头契约）
		if name, ok := upstreamHeaderName(key); ok && name != "openai-beta" && name != "accept" {
			req.Header.Set(name, value)
		}
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
func peekStream(resp *http.Response) ([]byte, *upstreamFailure, error) {
	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	resp.Body = readCloser{Reader: reader, Closer: resp.Body}
	var buffered bytes.Buffer
	events := 0
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
				return buffered.Bytes(), nil, nil
			}
			eventType, _ := event["type"].(string)
			if eventType == "response.failed" || eventType == "error" {
				failure := classifySSEFailure(event)
				return buffered.Bytes(), &failure, nil
			}
			if !replayablePreambleEvents[eventType] {
				return buffered.Bytes(), nil, nil
			}
		}
		if err != nil {
			return buffered.Bytes(), nil, err
		}
	}
	return buffered.Bytes(), nil, nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// commit 写出响应头（提交点）与剩余正文，记录 usage/额度并写 Receipt。
func (d *dispatchRun) commit(w http.ResponseWriter, resp *http.Response, account Account, record attemptRecord, preamble []byte, attemptStarted time.Time) {
	s := d.server
	defer resp.Body.Close()
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
	w.Header().Set(sendStateHeader, sendStateSent)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	if d.sentServiceTier != "" {
		w.Header().Set("X-Kin-Gateway-Service-Tier", d.sentServiceTier)
	}
	w.WriteHeader(resp.StatusCode)
	firstOutput := time.Since(attemptStarted)
	observer := newSSEObserver(d.envelope.Stream)
	turnState := resp.Header.Get("x-codex-turn-state")
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
		s.store.RecordSuccess(account.ID)
		s.store.RecordFeedback(account.ID, feedbackSucceeded, firstOutput)
		if d.countable {
			s.store.RecordProtectionSuccess(account.ID, d.protectionVersion)
		}
	}
	if observer.failed && observer.failure != nil {
		s.store.Dispose(account.ID, d.envelope.Model, *observer.failure, time.Now())
		d.feedback(account.ID, *observer.failure)
		d.protectFailure(account.ID, *observer.failure)
	}
	if len(observer.rateLimits) > 0 {
		s.store.MergeQuota(account.ID, observer.rateLimits)
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
	d.writeReceipt(account, resp.StatusCode, terminal, errorCode, sendStateSent, resp.Header, observer)
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
	status, body := failure.clientProjection()
	if failure.header != nil {
		for _, key := range []string{"Retry-After", "X-Request-Id"} {
			if value := failure.header.Get(key); value != "" {
				w.Header().Set(key, value)
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(sendStateHeader, state)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	w.Header().Set(errorCategoryHeader, string(failure.Category))
	if d.lastAcct.ID != "" && state != sendStateNotSent {
		w.Header().Set("X-Kin-Gateway-Account", d.lastAcct.ID)
		w.Header().Set("X-Kin-Gateway-Credential-Revision", fmt.Sprint(d.lastAcct.CredentialRevision))
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
	d.writePreviousResponseNotFound(w, sendStateSent)
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

func (d *dispatchRun) writePreviousResponseNotFound(w http.ResponseWriter, state string) {
	w.Header().Set(sendStateHeader, state)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	w.Header().Set(errorCategoryHeader, string(categoryUsageLimit))
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "previous_response_not_found", "param": "previous_response_id", "message": "Previous response is no longer available on its account; retry without previous_response_id and include the full conversation."}})
	if d.sentAny {
		d.writeReceipt(d.lastAcct, http.StatusBadRequest, terminalUpstreamError, "previous_response_not_found", state, nil, nil)
	}
}

// finishWithoutAccount：范围内无可用账号。尚未发送任何请求时告诉控制面可换实例。
func (d *dispatchRun) finishWithoutAccount(w http.ResponseWriter, err error) {
	if d.continuation() && errors.Is(err, ErrUsageLimitExhausted) {
		d.writePreviousResponseNotFound(w, sendStateNotSent)
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
	s := d.server
	usageConfidence := "unknown"
	var usage any
	var quota map[string]any
	quotaConfidence := "unknown"
	if header != nil {
		evidence := parseQuotaHeaders(header, time.Now())
		quota = quotaMap(evidence)
		quotaConfidence = evidence.Confidence
	}
	if observer != nil && observer.usage != nil {
		usage = observer.usage
		usageConfidence = "complete"
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
		"receipt_id": "receipt_" + d.envelope.Dispatch, "dispatch_id": d.envelope.Dispatch, "request_id": d.envelope.RequestID,
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
	o.terminal = true
}

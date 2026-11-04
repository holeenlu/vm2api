package codexgateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
	"github.com/tidwall/gjson"
)

// BPS（ChatGPT Excel Basispoints）是 OpenAI OAuth 账号上的附加授权（与 sub2api 相同）：同一账号同时持有
// 原生 Codex 授权与独立的 Excel 授权（Account.BPS），控制面投影 BPS 设置（Account.BPSSettings）。
// 请求模型在账号 BPS 名单内时先走 BPS 通道：basispoints 协议包把 Responses 转为 BPS 请求，上游 SSE 再转回
// 标准 Responses SSE，交给既有的前导缓冲、提交、回执与失败处置。BPS 的限流、模型无权、授权失效与 403 停用
// 只记在 Account.BPS 上；额度窗口与耗尽结论两条通道共享（同一 ChatGPT 账号）。

// bpsRefreshScope 是 Excel 授权刷新时的 scope（与 sub2api Excel 刷新一致）。
const bpsRefreshScope = "openid profile email"

// authModeHeader 告知控制面本次实际承接请求的通道（native / bps），写入使用记录。
const authModeHeader = "X-Kin-Gateway-Auth-Mode"

// BPS 状态：expired 为 AT 被拒或过期且无法刷新，invalid 为刷新令牌失效，blocked 为账号级 403 后按设置停用。
const (
	bpsStateExpired = "expired"
	bpsStateInvalid = "invalid"
	bpsStateBlocked = "blocked"
)

// bpsRecoveryDefaultInterval 是 403 停用后的默认探测间隔（sub2api 默认 60 分钟，范围 1–10080）。
const bpsRecoveryDefaultInterval = 60 * time.Minute

// BPSGrant 是账号上的 Excel 授权与 BPS 通道状态（Worker 自有，控制面投影不覆盖）。
type BPSGrant struct {
	AccessToken  string    `json:"access_token,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	IDToken      string    `json:"id_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	// Revision 是 BPS 授权代次，与原生 CredentialRevision 独立
	Revision       int64                `json:"revision"`
	State          string               `json:"state,omitempty"`
	LastError      string               `json:"last_error,omitempty"`
	CooldownUntil  time.Time            `json:"cooldown_until,omitempty"`
	ModelCooldowns map[string]time.Time `json:"model_cooldowns,omitempty"`
	BlockedAt      time.Time            `json:"blocked_at,omitempty"`
	ProbedAt       time.Time            `json:"probed_at,omitempty"`
	// ScopedCooldowns 是上游 429 明确声明范围（error.scope）时的冷却，键见 bpsCooldownKey；
	// 未声明范围的 429 写 CooldownUntil（整个 BPS 通道）
	ScopedCooldowns map[string]time.Time `json:"scoped_cooldowns,omitempty"`
	// PolicyBackoff 是按模型的 usage-policy 403 退避（30/60/120/240/300 秒），成功后清除
	PolicyBackoff map[string]bpsBackoff `json:"policy_backoff,omitempty"`
	// RecoveryStopped：运营停止了本次 403 停用的自动恢复探测（再次停用或手动解除时清除）
	RecoveryStopped bool `json:"recovery_stopped,omitempty"`
}

// bpsPause 汇总 BPS 通道的暂停：next_probe_at 是 403 停用后的下次恢复探测时刻，cooldown_until 是最晚的限流/退避到期时刻。
func (account Account) bpsPause(now time.Time) map[string]any {
	grant, settings := account.BPS, account.BPSSettings
	if grant == nil {
		return nil
	}
	out := map[string]any{}
	if grant.State == bpsStateBlocked {
		switch {
		case settings == nil || !settings.AutoRecoverOn403 || len(settings.Models) == 0:
			out["bps_recovery"] = "off"
		case grant.RecoveryStopped:
			out["bps_recovery"] = "stopped"
		default:
			out["bps_recovery"] = "auto"
			last := grant.ProbedAt
			if last.IsZero() {
				last = grant.BlockedAt
			}
			out["bps_next_probe_at"] = last.Add(settings.recoveryInterval()).UTC().Format(time.RFC3339Nano)
		}
	}
	latest := time.Time{}
	consider := func(until time.Time) {
		if until.After(now) && until.After(latest) {
			latest = until
		}
	}
	consider(grant.CooldownUntil)
	for _, until := range grant.ScopedCooldowns {
		consider(until)
	}
	for _, backoff := range grant.PolicyBackoff {
		consider(backoff.Until)
	}
	if !latest.IsZero() {
		out["bps_cooldown_until"] = latest.UTC().Format(time.RFC3339Nano)
	}
	return out
}

type bpsBackoff struct {
	Until   time.Time `json:"until"`
	Strikes int       `json:"strikes"`
}

// BPSSettings 是控制面投影的账号 BPS 设置。
type BPSSettings struct {
	Enabled bool `json:"enabled"`
	// Models 是走 BPS 的模型名单；名单只决定通道，空名单不等于全部走 BPS
	Models []string `json:"models,omitempty"`
	// OmitUnsupportedTools：请求声明了 BPS 不能承载的托管工具时省略它们继续走 BPS；关闭时这类请求走原生
	OmitUnsupportedTools bool `json:"omit_unsupported_tools,omitempty"`
	// IgnoreEncryptedContent：历史含加密内容时去掉密文继续走 BPS；关闭时这类请求走原生
	IgnoreEncryptedContent bool `json:"ignore_encrypted_content,omitempty"`
	// AutoDisableOn403：BPS 账号级 403 时停用该账号的 BPS（原生不受影响）；AutoRecoverOn403 按间隔探测恢复
	AutoDisableOn403        bool `json:"auto_disable_on_403,omitempty"`
	AutoRecoverOn403        bool `json:"auto_recover_on_403,omitempty"`
	RecoveryIntervalMinutes int  `json:"recovery_interval_minutes,omitempty"`
	// CacheCreationAsInput：BPS 上报的缓存写入 token 按普通输入计（下游与回执的缓存写入用量归零）
	CacheCreationAsInput bool `json:"cache_creation_as_input,omitempty"`
}

func (settings *BPSSettings) recoveryInterval() time.Duration {
	if settings == nil || settings.RecoveryIntervalMinutes <= 0 {
		return bpsRecoveryDefaultInterval
	}
	return time.Duration(settings.RecoveryIntervalMinutes) * time.Minute
}

// bpsState 是进程内的 BPS 协议状态：工具调用回放与会话工具目录（按账号/调用方/会话/授权代次隔离）。
type bpsState struct {
	replay  basispoints.ReplayCache
	catalog basispoints.CatalogCache
	// attachments 复用已上传图片的附件 ID（按账号/调用方/会话/授权代次与工作区隔离，1 小时、512 条）；
	// uploader 限制进程内并发上传
	attachments basispoints.AttachmentCache
	uploader    basispoints.AttachmentUploader
	// disk 是工具回放与会话目录的跨重启存储（bps_state.go）；为空时只用进程内缓存
	disk *bpsDiskState
	// refreshMu 串行化请求内的 401 刷新（同一刷新令牌只用一次）
	refreshMu sync.Mutex
	// catalogs 是账号 BPS 模型目录缓存（bps_models.go）
	catalogs bpsCatalogCache
	// probes 是待随心跳上报的 403 恢复探测记录（bps_media.go）
	probeMu sync.Mutex
	probes  bpsProbeQueue
}

// bpsUnsupportedError：协议包拒绝转换该请求（发送前），本请求改走原生通道。
type bpsUnsupportedError struct {
	err error
	// sent：上游已收到请求但拒绝了请求格式、尚未生成内容（图片端点改走原生）
	sent bool
}

func (e *bpsUnsupportedError) Error() string { return e.err.Error() }
func (e *bpsUnsupportedError) Unwrap() error { return e.err }

// bpsRequest 是请求本身对 BPS 的可承载性（与账号无关），首次选号时判定一次。
type bpsRequest struct {
	// Supported：Responses/Chat 流式、完整历史（无 previous_response_id 与原生续接）
	Supported bool
	// HostedTools / Encrypted 需要账号相应开关才能走 BPS
	HostedTools bool
	Encrypted   bool
	// Images：请求带图片，会用到附件端点（附件端点的 429 冷却只影响带图请求）
	Images bool
	// ImageOp：图片生成/编辑请求走 BPS 图片端点（bps_image_ops.go）
	ImageOp string
}

func inspectBPSRequest(envelope Envelope, body []byte, nativeContinuation bool) bpsRequest {
	if bpsImageOperation(envelope.Operation) != "" {
		return inspectBPSImagesRequest(envelope, body)
	}
	if envelope.Operation != "responses" && envelope.Operation != "chat" {
		return bpsRequest{}
	}
	if !envelope.Stream || nativeContinuation || !gjson.ValidBytes(body) {
		return bpsRequest{}
	}
	if strings.TrimSpace(gjson.GetBytes(body, "previous_response_id").String()) != "" {
		return bpsRequest{}
	}
	// generate=false 预热不产生输出：交给原生通道（原生 WS 预热），不在 BPS 上发起真实生成
	if generate := gjson.GetBytes(body, "generate"); generate.Exists() && generate.Type == gjson.False {
		return bpsRequest{}
	}
	// 强制选择或必须外部执行的托管工具（生图、外部联网搜索）BPS 无法承载，与开关无关
	if basispoints.UnsupportedHostedToolsReason(body) != "" {
		return bpsRequest{}
	}
	// 加密消息内容（协议包会拒绝）只在账号开启“忽略加密内容”时去掉密文继续走 BPS；顶层加密推理项照常转发
	encrypted := false
	if bytes.Contains(body, []byte(`"encrypted_content"`)) {
		stripped, err := basispoints.StripEncryptedContent(body)
		encrypted = err == nil && !bytes.Equal(stripped, body)
	}
	images := bytes.Contains(body, []byte(`"input_image"`)) || bytes.Contains(body, []byte(`"image_url"`))
	return bpsRequest{Supported: true, HostedTools: basispoints.DeclaresHostedTools(body), Encrypted: encrypted, Images: images}
}

// bpsUsable 判断账号的 BPS 通道能否承接该模型的这个请求。
func bpsUsable(account Account, model string, request bpsRequest, now time.Time) bool {
	settings, grant := account.BPSSettings, account.BPS
	if !request.Supported || settings == nil || !settings.Enabled || grant == nil || grant.AccessToken == "" {
		return false
	}
	if grant.State != "" || !contains(settings.Models, model) {
		return false
	}
	if (request.HostedTools && !settings.OmitUnsupportedTools) || (request.Encrypted && !settings.IgnoreEncryptedContent) {
		return false
	}
	if !grant.ExpiresAt.IsZero() && !grant.ExpiresAt.After(now) {
		return false
	}
	if grant.CooldownUntil.After(now) {
		return false
	}
	if until, ok := grant.ModelCooldowns[model]; ok && until.After(now) {
		return false
	}
	if backoff, ok := grant.PolicyBackoff[model]; ok && backoff.Until.After(now) {
		return false
	}
	endpoints := []string{bpsEndpointResponses}
	if request.ImageOp != "" {
		endpoints = []string{request.ImageOp}
	} else if request.Images {
		endpoints = append(endpoints, bpsEndpointAttachments)
	}
	for _, endpoint := range endpoints {
		for _, key := range []string{bpsCooldownKey(model, ""), bpsCooldownKey("", endpoint), bpsCooldownKey(model, endpoint)} {
			if until, ok := grant.ScopedCooldowns[key]; ok && until.After(now) {
				return false
			}
		}
	}
	return true
}

// bpsRoute 是本次选号的通道：全局开关开、请求可承载且本请求尚未放弃 BPS 时先走 BPS 阶段。
func (d *dispatchRun) bpsRoute() bool {
	if d.bpsDone || !d.envelope.Scheduling.BPSEnabled {
		return false
	}
	if !d.bpsChecked {
		d.bpsChecked = true
		d.bpsRequest = inspectBPSRequest(d.envelope, d.body, d.nativeContinuation)
	}
	return d.bpsRequest.Supported
}

// bpsScope 隔离回放与工具目录：账号、调用方、会话与 BPS 授权代次任一不同都不共享。
func (d *dispatchRun) bpsScope(account Account) string {
	thread := firstString(d.envelope.Scope.SessionID, d.inboundHeader("session-id"), gjson.GetBytes(d.body, "prompt_cache_key").String())
	return fmt.Sprintf("account:%s/key:%s/thread:%s/bps:%d", account.ID, d.envelope.ClientScope, thread, account.BPS.Revision)
}

func bpsChatGPTAccountID(account Account) string {
	if id := strings.TrimSpace(account.ChatGPTAccountID); id != "" {
		return id
	}
	auth, _ := jwtClaims(account.BPS.AccessToken)["https://api.openai.com/auth"].(map[string]any)
	return firstString(auth["chatgpt_account_id"])
}

func (s *Server) bpsURL(path string) string {
	return strings.TrimRight(s.cfg.BPSBaseURL, "/") + path
}

// sendBPS 转换并发送一次 BPS 请求；成功响应的正文是转换后的 Responses SSE。
func (d *dispatchRun) sendBPS(ctx context.Context, account Account) (*http.Response, bool, error) {
	d.bpsStage = "prepare"
	if d.bpsRequest.ImageOp != "" {
		d.bpsStage = "images_endpoint"
		return d.sendBPSImages(ctx, account)
	}
	s := d.server
	body, err := d.privacy.applyBody(ctx, d.body, http.Header{})
	if err != nil {
		return nil, false, err
	}
	if d.bpsRequest.Encrypted {
		if body, err = basispoints.StripEncryptedContent(body); err != nil {
			return nil, false, &bpsUnsupportedError{err: err}
		}
	}
	client, err := s.clientFor(account)
	if err != nil {
		return nil, false, err
	}
	scope := d.bpsScope(account)
	replay, catalog := s.bpsCaches(ctx)
	var prepared []byte
	var bridge *basispoints.Bridge
	// 远程图片先经账号代理下载为内嵌图片，再与其他图片一样上传为附件
	if body, err = s.inlineRemoteBPSImages(ctx, client, body); err != nil {
		return nil, false, err
	}
	var window []any
	var windowUsage map[string]any
	if bytes.Contains(body, []byte(`"input_image"`)) || bytes.Contains(body, []byte(`"image_url"`)) {
		// 图片按 BPS 原生附件上传（multipart，按摘要去重与复用），再把消息图片改写为 file_id；
		// 超过图片上限时按图片策略处理（自动压缩历史 / 提醒 / 关闭，见 bps_images.go）
		d.bpsStage = "images"
		plan, err := s.planBPSImages(ctx, d, scope, body)
		if err != nil {
			return nil, false, err
		}
		if plan.reconciled != nil {
			body = plan.reconciled
		}
		d.bpsImagePlan, d.bpsImageWindow = plan, nil
		var images *basispoints.NativeImages
		if plan.split > 0 {
			images, err = basispoints.PrepareNativeImagesForCompaction(body, plan.settings.MaxImages, plan.split)
		} else {
			images, err = basispoints.PrepareNativeImagesWithLimit(body, plan.maxImages)
		}
		if err != nil {
			return nil, false, &bpsUnsupportedError{err: err}
		}
		d.bpsImages = images
		images.UseCache(&s.bps.attachments, scope+"/workspace:"+bpsChatGPTAccountID(account))
		upload := s.bpsAttachmentUploader(client, account)
		d.bpsStage = "attachments"
		uploadedBody, rejected, err := upload(ctx, images)
		if rejected != nil || err != nil {
			return rejected, rejected != nil, err
		}
		if prepared, bridge, err = images.PrepareWithCatalog(scope, replay, catalog); err != nil {
			return nil, false, &bpsUnsupportedError{err: err}
		}
		if plan.split > 0 {
			d.bpsStage = "compaction"
			var failed *http.Response
			prepared, bridge, window, windowUsage, failed, err = s.compactBPSImageHistory(ctx, client, account, plan, images, bridge, uploadedBody, upload)
			if failed != nil || err != nil {
				return failed, failed != nil, err
			}
			d.bpsImageWindow = window
		}
	} else if prepared, bridge, err = basispoints.PrepareWithCatalog(body, scope, replay, catalog); err != nil {
		return nil, false, &bpsUnsupportedError{err: err}
	}
	d.bpsStage = "responses"
	resp, wrote, err := s.postBPS(ctx, client, account, prepared)
	if err != nil || resp.StatusCode >= 300 {
		return resp, wrote, err
	}
	return s.convertBPS(ctx, client, account, prepared, bridge, resp, window, windowUsage), true, nil
}

func (s *Server) postBPS(ctx context.Context, client *http.Client, account Account, body []byte) (*http.Response, bool, error) {
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) }}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodPost, s.bpsURL("/responses"), bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	setBPSHeaders(req.Header, account, "text/event-stream")
	req.ContentLength = int64(len(body))
	resp, err := client.Do(req)
	if err != nil {
		return nil, wrote.Load(), err
	}
	return resp, true, nil
}

// setBPSHeaders 是 Excel 插件的请求头（sub2api newExcelBPSRequestTo）；不发 originator 与 Codex 版本头。
func setBPSHeaders(header http.Header, account Account, accept string) {
	accountID := bpsChatGPTAccountID(account)
	values := http.Header{
		"Authorization": {"Bearer " + account.BPS.AccessToken}, "Chatgpt-Account-Id": {accountID}, "X-Openai-Account-Id": {accountID},
		"X-Basispoints-Auth-Mode": {"chatgpt"}, "Content-Type": {"application/json"}, "Accept": {accept},
		"Origin": {"https://bps.openai.com"}, "User-Agent": {"Mozilla/5.0"},
		"X-Openai-Internal-Basispoints-Client-Product":       {"basispoints-excel-plugin"},
		"X-Openai-Internal-Basispoints-Client-Agent-Profile": {"excel"},
	}
	for key, value := range values {
		header[key] = value
	}
}

// bpsBody 是转换后的 Responses SSE；关闭时取消转换（含进行中的工具纠正请求）并等待其结束。
type bpsBody struct {
	*io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}
	// usage 是转换结束时累计的上游用量（含纠正轮与中断前已上报的计数），在 done 关闭前写入
	usage map[string]any
}

// finalUsage 在流结束后返回累计用量；用于流中断、取消或失败时回执仍按已消耗的用量结算（sub2api 失败轮计费）。
func (b *bpsBody) finalUsage() map[string]any {
	_ = b.Close()
	return b.usage
}

func (b *bpsBody) Close() error {
	b.cancel()
	err := b.PipeReader.Close()
	<-b.done
	return err
}

// convertBPS 在后台把 BPS SSE 转成 Responses SSE。工具调用格式不合格时，按协议包的纠正需求
// 在同一账号上发出纠正请求（最多两轮，由协议包限定），纠正轮的用量计入最终 usage。
func (s *Server) convertBPS(ctx context.Context, client *http.Client, account Account, prepared []byte, bridge *basispoints.Bridge, resp *http.Response, window []any, windowUsage map[string]any) *http.Response {
	ctx, cancel := context.WithCancel(ctx)
	reader, writer := io.Pipe()
	done := make(chan struct{})
	var mu sync.Mutex
	active := resp.Body
	closeActive := func() {
		mu.Lock()
		body := active
		active = nil
		mu.Unlock()
		if body != nil {
			_ = body.Close()
		}
	}
	accept := func(body io.ReadCloser) {
		mu.Lock()
		active = body
		mu.Unlock()
		if ctx.Err() != nil {
			closeActive()
		}
	}
	body := &bpsBody{PipeReader: reader, cancel: cancel, done: done}
	go func() {
		defer close(done)
		defer cancel()
		stop := context.AfterFunc(ctx, closeActive)
		defer stop()
		cacheAsInput := account.BPSSettings != nil && account.BPSSettings.CacheCreationAsInput
		conversion := bridge.NewStreamConversion(func(kind string, payload []byte) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if cacheAsInput && terminalStreamEvents[kind] {
				payload = bpsCacheCreationAsInput(payload)
			}
			_, err := fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", kind, payload)
			return err
		}, basispoints.RepairPolicy{ToolTransport: true, UnknownTarget: true})
		// 图片历史自动压缩后，压缩窗口作为输出前缀交给客户端，其用量并入终态 usage
		conversion.SetCompactedWindow(window, windowUsage)
		// 流空闲超时：上游在 BPSStreamIdleSec 内没有新数据时结束（纠正轮同样受限）
		idle := time.Duration(s.cfg.BPSStreamIdleSec) * time.Second
		demand, err := conversion.Convert(basispoints.WithProgressTimeout(ctx, resp.Body, idle))
		for demand != nil && err == nil {
			closeActive()
			corrected, repairErr := s.repairBPS(ctx, client, account, &prepared, demand, accept)
			if repairErr == nil && ctx.Err() != nil {
				repairErr = ctx.Err()
			}
			demand, err = conversion.ResolveRepair(corrected, repairErr)
		}
		if err == nil {
			err = conversion.Deliver(bridge.CommitReplays(conversion.Replays()))
		}
		closeActive()
		body.usage = conversion.Usage()
		_ = writer.CloseWithError(err)
	}()
	header := http.Header{"Content-Type": {"text/event-stream"}}
	for key, values := range resp.Header {
		// 请求关联 ID 与 Codex 额度头（BPS 与原生共享同一 ChatGPT 账号的额度）照常交给执行链
		if key == "X-Request-Id" || key == "Cf-Ray" || isCodexQuotaHeader(key) {
			header[key] = values
		}
	}
	return &http.Response{StatusCode: http.StatusOK, Header: header, Body: body}
}

func (s *Server) repairBPS(ctx context.Context, client *http.Client, account Account, prepared *[]byte, demand *basispoints.RepairDemand, accept func(io.ReadCloser)) (map[string]any, error) {
	var wire []byte
	var err error
	switch demand.Kind {
	case basispoints.RepairToolTransport, basispoints.RepairUnknownContinuation:
		wire, err = basispoints.BuildToolRepairRequest(*prepared, demand.FailedResponse, demand.Validation)
	case basispoints.RepairUnknownTarget:
		wire, err = basispoints.RepairRequest(*prepared)
	default:
		return nil, errors.New("invalid BPS repair demand")
	}
	if err != nil {
		return nil, err
	}
	// 第二轮纠正包含第一轮的 executed=false 反馈
	*prepared = wire
	resp, _, err := s.postBPS(ctx, client, account, wire)
	if err != nil {
		return nil, fmt.Errorf("BPS correction request failed: %w", err)
	}
	accept(resp.Body)
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
		if failure := basispoints.ParseHTTPFailure(resp.StatusCode, raw); failure != nil {
			return nil, failure
		}
		return nil, fmt.Errorf("BPS correction returned HTTP %d", resp.StatusCode)
	}
	if demand.Kind == basispoints.RepairUnknownTarget {
		return basispoints.ReadRepairResponse(basispoints.WithProgressTimeout(ctx, resp.Body, time.Duration(s.cfg.BPSStreamIdleSec)*time.Second))
	}
	return basispoints.ReadToolRepairResponse(basispoints.WithProgressTimeout(ctx, resp.Body, time.Duration(s.cfg.BPSStreamIdleSec)*time.Second))
}

// bpsAccountBlockedCodes 是 BPS 对账号或工作区的终态拒绝（sub2api openai_excel_bps_auth_failure.go）。
var bpsAccountBlockedCodes = map[string]bool{
	"account_deactivated": true, "account_suspended": true, "account_banned": true, "account_disabled": true,
	"workspace_deactivated": true, "workspace_suspended": true, "workspace_disabled": true, "bps_account_blocked": true,
}

// classifyBPSHTTPFailure 在通用分类上补充 BPS 的 403 语义：模型无权按模型冷却，账号/工作区终态拒绝按封禁处理，
// 其余 403 只对本请求换号（生成前拒绝）。
func classifyBPSHTTPFailure(status int, header http.Header, body []byte, now time.Time) upstreamFailure {
	failure := classifyHTTPFailure(status, header, body, now)
	if status == http.StatusForbidden {
		switch code := normalizeToken(failure.Code); {
		case code == "model_not_allowed" || code == "basispoints_model_access_changed":
			failure.Category = categoryModelUnsupported
		case bpsAccountBlockedCodes[code]:
			failure.Category = categoryBanned
		case code == "" && strings.Contains(strings.ToLower(failure.Message), "usage policy"):
			failure.bpsUsagePolicy = true
			failure.Category = categoryPermissionDenied
		}
	}
	failure.bpsEndpoint = bpsEndpointResponses
	if endpoint := header.Get(bpsEndpointHeader); endpoint != "" {
		failure.bpsEndpoint = endpoint
	}
	markBPSFailure(&failure)
	return failure
}

// bpsPolicyCodes 是上游的内容/网络安全拒绝（sub2api IsUpstreamContentRefusal）：不重放、不换号、不转原生。
var bpsPolicyCodes = map[string]bool{
	"content_policy_violation": true, "content_policy_error": true, "safety_error": true, "content_policy": true,
	"content_filter": true, "content_filter_refusal": true, "moderation_blocked": true, "safety_violation": true,
}

// markBPSFailure 标记 BPS 通道的失败并按 sub2api 的 BPS 规则投影：网络安全拒绝返回 400 cyber_policy，
// 内容拒绝返回 400 content_policy_violation，二者都不重放；其余 401/403 对调用方隐藏为 503
// （Codex 会把网关的 401 当作自身登录失效、403 当作 Key 被封）。
func markBPSFailure(failure *upstreamFailure) {
	failure.bps = true
	code, kind := normalizeToken(failure.Code), normalizeToken(failure.Type)
	if failure.bpsEndpoint == "" {
		failure.bpsEndpoint = bpsEndpointResponses
	}
	if code == "invalid_encrypted_content" {
		// 对齐 sub2api：密文被拒不重试、不换号、不转原生、不改账号状态，提示重发明文历史
		failure.Status = http.StatusBadRequest
		failure.Category = categoryInvalidRequest
		failure.Body, _ = json.Marshal(map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": "invalid_encrypted_content", "message": "The upstream could not verify the encrypted conversation state. Resend the original plaintext history or start a new conversation."}})
		return
	}
	switch {
	case code == "cyber_policy" || kind == "cyber_policy":
		failure.bpsPolicy = "cyber_policy"
	case bpsPolicyCodes[code] || bpsPolicyCodes[kind]:
		failure.bpsPolicy = "content_policy_violation"
	}
	if failure.bpsPolicy != "" {
		failure.Status = http.StatusBadRequest
		failure.Body, _ = json.Marshal(map[string]any{"error": map[string]any{"type": "invalid_request_error", "code": failure.bpsPolicy, "message": "The request was refused by the upstream usage policy; it was not replayed."}})
	}
}

// bpsOAuthURL 是 Excel 插件的浏览器 PKCE 授权地址；回调落在官方 bps.openai.com，运营把回调链接粘回后台。
func bpsOAuthURL(cfg Config, session OAuthSession) string {
	sum := sha256.Sum256([]byte(session.CodeVerifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	query := url.Values{
		"client_id": {cfg.BPSClientID}, "response_type": {"code"},
		"redirect_uri": {cfg.BPSRedirectURI}, "scope": {"openid offline_access email profile organization.read"},
		"state": {session.State}, "code_challenge_method": {"S256"}, "code_challenge": {challenge},
		"audience": {"https://api.openai.com/v1"}, "platform": {"PC"},
	}
	return cfg.BPSAuthorizeURL + "?" + query.Encode()
}

// dispose 按本次尝试的通道处置失败：BPS 失败只写账号的 BPS 状态（额度耗尽除外），不计入原生健康分、
// 错误保护与过载反馈；原生失败沿用原有处置。
func (d *dispatchRun) dispose(id string, failure upstreamFailure, now time.Time) {
	if d.bpsAttempt {
		d.server.store.DisposeBPS(id, d.envelope.Model, failure, now)
		return
	}
	d.server.store.Dispose(id, d.envelope.Model, failure, now)
	d.feedback(id, failure)
	d.protectFailure(id, failure)
}

// bpsFailed 记录 BPS 阶段的换号：排除该账号的 BPS 通道，换号用尽时进入原生阶段。
func (d *dispatchRun) bpsFailed(id string) {
	d.bpsExclude[id] = true
	d.bpsSwitches++
	if d.bpsSwitches > maxAccountSwitches {
		d.bpsDone = true
	}
}

func (d *dispatchRun) authMode() string {
	if d.bpsAttempt {
		return "bps"
	}
	return "native"
}

// bpsCacheCreationAsInput 把终态事件 usage 中的缓存写入 token 归零：OpenAI 口径的 input_tokens 已包含这部分，
// 归零后按普通输入计价；Anthropic 口径的 cache_creation_input_tokens 不在 input_tokens 内，先并入再归零。
func bpsCacheCreationAsInput(payload []byte) []byte {
	var event map[string]any
	if json.Unmarshal(payload, &event) != nil {
		return payload
	}
	response, _ := event["response"].(map[string]any)
	usage, _ := response["usage"].(map[string]any)
	if usage == nil {
		return payload
	}
	changed := false
	zero := func(container map[string]any, key string) {
		if value, ok := container[key].(float64); ok && value != 0 {
			container[key] = 0
			changed = true
		}
	}
	if creation, ok := usage["cache_creation_input_tokens"].(float64); ok && creation > 0 {
		input, _ := usage["input_tokens"].(float64)
		usage["input_tokens"] = input + creation
		zero(usage, "cache_creation_input_tokens")
	}
	for _, key := range []string{"cache_creation_tokens", "cache_write_tokens"} {
		zero(usage, key)
	}
	if details, ok := usage["input_tokens_details"].(map[string]any); ok {
		for _, key := range []string{"cache_creation_tokens", "cache_write_tokens"} {
			zero(details, key)
		}
	}
	if !changed {
		return payload
	}
	out, err := json.Marshal(event)
	if err != nil {
		return payload
	}
	return out
}

// uploadBPSAttachment 把一张图片上传为 BPS 附件（multipart 字段 file），返回 openai_file_id。
// 上游拒绝时返回可交给执行链分类的失败响应（正文已读入内存）。
func (s *Server) uploadBPSAttachment(ctx context.Context, client *http.Client, account Account, image basispoints.InlineAttachment) (string, *http.Response, error) {
	reader, contentType, length, err := image.Multipart()
	if err != nil {
		return "", nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.bpsURL("/attachments"), reader)
	if err != nil {
		return "", nil, err
	}
	setBPSHeaders(req.Header, account, "application/json")
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept-Encoding", "identity")
	req.ContentLength = length
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		failed := &http.Response{StatusCode: resp.StatusCode, Header: resp.Header.Clone(), Body: io.NopCloser(bytes.NewReader(raw))}
		return "", failed, fmt.Errorf("BPS attachment upload returned %d", resp.StatusCode)
	}
	var result struct {
		OpenAIFileID string `json:"openai_file_id"`
	}
	if len(raw) > 64<<10 || json.Unmarshal(raw, &result) != nil || !basispoints.ValidAttachmentID(result.OpenAIFileID) {
		return "", nil, errors.New("BPS attachment upload returned an invalid response")
	}
	return result.OpenAIFileID, nil, nil
}

// bpsOwnershipRetry：上游判定附件不属于本账号（复用的附件 ID 失效）时作废该请求的附件缓存，
// 同账号重新上传原图并重发一次（sub2api 附件归属恢复）。
func (d *dispatchRun) bpsOwnershipRetry(failure upstreamFailure) bool {
	if !d.bpsAttempt || d.bpsImages == nil || d.bpsOwnershipRetried || failure.Code != basispoints.FileOwnershipFailureCode {
		return false
	}
	d.bpsOwnershipRetried = true
	d.bpsImages.InvalidateAttachmentCache()
	return true
}

// resolveRouteHistory 按历史来源决定本请求可用的通道；返回 false 表示已交付错误。
func (d *dispatchRun) resolveRouteHistory(w http.ResponseWriter) bool {
	keys := historyKeys(d.body)
	if len(keys) == 0 {
		return true
	}
	routes := d.server.provenance.lookup(d.envelope.ClientScope, keys)
	switch {
	case routes[routeBPS] && routes[routeNative]:
		d.deliverRouteError(w, http.StatusBadRequest, "invalid_request_error", "codex_route_history_conflict", "The conversation history mixes BPS and native Codex encrypted state and cannot be replayed on either route; start a new conversation.")
		return false
	case routes[routeBPS]:
		d.routePinned = routeBPS
	case routes[routeNative]:
		d.routePinned = routeNative
		d.bpsDone = true
	default:
		d.routeLocked = true
	}
	return true
}

// routeAllowsNative 在本请求将改走原生通道前检查历史锁定；返回 false 表示已交付错误。
func (d *dispatchRun) routeAllowsNative(w http.ResponseWriter) bool {
	switch {
	case d.envelope.Scheduling.RoutePolicy == routePolicyBPSOnly && d.bpsTried && d.lastFail != nil:
		d.deliverFailure(w)
	case d.envelope.Scheduling.RoutePolicy == routePolicyBPSOnly:
		d.deliverRouteError(w, http.StatusServiceUnavailable, "server_error", "codex_route_basispoints_required", "This API key only uses BPS, and no BPS account can serve this request.")
	case d.routePinned == routeBPS && d.bpsTried && d.lastFail != nil:
		d.deliverFailure(w)
	case d.routePinned == routeBPS && !d.envelope.Scheduling.BPSEnabled:
		d.deliverRouteError(w, http.StatusServiceUnavailable, "server_error", "codex_route_basispoints_disabled", "The conversation history was produced through BPS, which is currently disabled.")
	case d.routePinned == routeBPS && d.bpsChecked && !d.bpsRequest.Supported:
		d.deliverRouteError(w, http.StatusBadRequest, "invalid_request_error", "codex_route_history_protocol_conflict", "The conversation history was produced through BPS, but this request uses features BPS cannot serve; remove them or start a new conversation.")
	case d.routePinned == routeBPS:
		d.deliverRouteError(w, http.StatusServiceUnavailable, "server_error", "codex_route_history_pinned", "The conversation history was produced through BPS and no BPS account is available right now.")
	case d.routeLocked && d.bpsTried && d.lastFail != nil:
		// 来源未知的不可重放历史：BPS 已尝试过，原生不一定能读取这段历史，不自动切换
		d.deliverFailure(w)
	default:
		return true
	}
	return false
}

func (d *dispatchRun) deliverRouteError(w http.ResponseWriter, status int, kind, code, message string) {
	w.Header().Set(sendStateHeader, sendStateNotSent)
	w.Header().Set(attemptsHeader, d.attemptsJSON())
	w.Header().Set(errorCategoryHeader, code)
	writeJSON(w, status, map[string]any{"error": map[string]any{"type": kind, "code": code, "message": message}})
}

// recordRouteHistory 在响应完整交付后记录其 response id 与输出密文来自哪条通道。
func (d *dispatchRun) recordRouteHistory(observer *sseObserver) {
	keys := append([]string(nil), observer.historyKeys...)
	if observer.responseID != "" {
		keys = append(keys, "resp:"+observer.responseID)
	}
	route := routeNative
	if d.bpsAttempt {
		route = routeBPS
	}
	d.server.provenance.record(d.envelope.ClientScope, route, keys)
}

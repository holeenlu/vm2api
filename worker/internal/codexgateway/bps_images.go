package codexgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
)

// BPS 图片策略（对齐 sub2api openai_excel_bps_image_policy.go，只用原生附件上传）。控制面经调度策略下发：
//   - auto_compact（默认）：图片超过上限或解码后合计超过上限时，在同一账号上先把可分离的历史压缩成 BPS
//     的压缩状态（compaction_trigger），再用“压缩窗口 + 未消费的新输入”生成；压缩窗口作为输出前缀交给 Codex，
//     检查点（不含内容）记在会话状态里，客户端回传时据此校验并重排历史。只支持官方 Codex 客户端。
//   - warn：不自动压缩；接近上限时提醒一次，超过上限时要求先执行 compact；
//   - off：不限张数（仍受单张与合计字节限制），超过合计字节直接报错。
type BPSImageSettings struct {
	Policy           string `json:"policy,omitempty"`
	MaxImages        int    `json:"max_images,omitempty"`
	MaxImageMiB      int    `json:"max_image_mib,omitempty"`
	MaxTotalMiB      int    `json:"max_total_mib,omitempty"`
	WarningRemaining int    `json:"warning_remaining"`
	CompactReserve   int    `json:"compact_reserve"`
}

// defaultBPSImageSettings 是控制面未下发时的缺省值（与 sub2api 默认一致）；提醒与预留允许显式为 0。
var defaultBPSImageSettings = BPSImageSettings{Policy: "auto_compact", MaxImages: 20, MaxImageMiB: basispoints.NativeImageMaxMiB, MaxTotalMiB: basispoints.NativeImageRequestBytes >> 20, WarningRemaining: 8, CompactReserve: 3}

func (s BPSImageSettings) normalized() BPSImageSettings {
	switch s.Policy {
	case "auto_compact", "warn", "off":
	default:
		s.Policy = "auto_compact"
	}
	if s.MaxImages <= 0 {
		s.MaxImages = 20
	}
	if s.MaxImageMiB <= 0 || s.MaxImageMiB > basispoints.NativeImageMaxMiB {
		s.MaxImageMiB = basispoints.NativeImageMaxMiB
	}
	if s.MaxTotalMiB <= 0 || s.MaxTotalMiB > basispoints.NativeImageRequestBytes>>20 {
		s.MaxTotalMiB = basispoints.NativeImageRequestBytes >> 20
	}
	if s.WarningRemaining < 0 || s.WarningRemaining >= s.MaxImages {
		s.WarningRemaining = min(8, s.MaxImages-1)
	}
	if s.CompactReserve < 0 || s.CompactReserve >= s.MaxImages {
		s.CompactReserve = min(3, s.MaxImages-1)
	}
	return s
}

// bpsImagePlan 是本请求的图片处理计划；split>0 表示先压缩 Input[:split]。
type bpsImagePlan struct {
	settings    BPSImageSettings
	history     *basispoints.ImageHistory
	reconciled  []byte
	split       int
	maxImages   int
	compact     bool
	stateScope  string
	previous    []byte
	version     uint64
	checkpoints []basispoints.ImageCheckpoint
}

type bpsImageState struct {
	Progress    basispoints.ImageProgress     `json:"progress"`
	Checkpoints []basispoints.ImageCheckpoint `json:"checkpoints,omitempty"`
	Warned      bool                          `json:"warned,omitempty"`
}

func imagePolicyError(status int, code, message string) error {
	return &bpsImageError{code: code, message: message, status: status}
}

func (d *dispatchRun) bpsImageSettings() BPSImageSettings {
	if settings := d.envelope.Scheduling.BPSImages; settings != nil {
		return settings.normalized()
	}
	return defaultBPSImageSettings
}

// codexClientRequest：自动压缩依赖客户端保存并回传压缩窗口，只对官方 Codex 客户端开启（以入站身份识别，不是授权边界）。
func (d *dispatchRun) codexClientRequest() bool {
	for _, name := range []string{"originator", "user-agent"} {
		if strings.Contains(strings.ToLower(d.inboundHeader(name)), "codex") {
			return true
		}
	}
	return false
}

func (s *Server) planBPSImages(ctx context.Context, d *dispatchRun, scope string, body []byte) (*bpsImagePlan, error) {
	settings := d.bpsImageSettings()
	history, err := basispoints.InspectImageHistory(body)
	if err != nil {
		return nil, &bpsUnsupportedError{err: err}
	}
	plan := &bpsImagePlan{settings: settings, history: history, maxImages: settings.MaxImages}
	if n := len(history.Input); n > 0 {
		if last, ok := history.Input[n-1].(map[string]any); ok && last["type"] == "compaction_trigger" {
			plan.compact = true
		}
	}
	limitBytes := int64(settings.MaxTotalMiB) << 20
	total, err := basispoints.InlineImageBytes(history.Input, settings.MaxImageMiB)
	if err != nil {
		return nil, &bpsUnsupportedError{err: err}
	}
	if settings.Policy == "off" {
		if total > limitBytes {
			return nil, imagePolicyError(400, "basispoints_image_auto_compact_disabled", fmt.Sprintf("Decoded inline images total %.2f MiB, exceeding the %d MiB limit; automatic history compaction is disabled. Resize or split images, or start a new conversation.", float64(total)/(1<<20), settings.MaxTotalMiB))
		}
		plan.maxImages = max(settings.MaxImages, history.Count)
		return plan, nil
	}
	store := s.bps.disk
	if store == nil {
		if plan.compact || (total <= limitBytes && history.Count <= settings.MaxImages) {
			return plan, nil
		}
		return nil, imagePolicyError(503, "basispoints_image_policy_state_unavailable", "Image policy session state is unavailable; run compact manually")
	}
	plan.stateScope = fmt.Sprintf("%s/images/policy:%s/limit:%d/warn:%d/reserve:%d", scope, settings.Policy, settings.MaxImages, settings.WarningRemaining, settings.CompactReserve)
	plan.previous, plan.version, err = store.LoadBPSState(ctx, plan.stateScope, "image-policy")
	if err != nil {
		return nil, imagePolicyError(503, "basispoints_image_policy_state_unavailable", "Image policy session state is unavailable; retry later")
	}
	var state bpsImageState
	if len(plan.previous) > 0 && json.Unmarshal(plan.previous, &state) != nil {
		return nil, imagePolicyError(503, "basispoints_image_policy_state_unavailable", "Invalid image session state; run compact manually")
	}
	plan.checkpoints = state.Checkpoints
	if len(state.Checkpoints) > 0 {
		changed, err := history.Reconcile(state.Checkpoints)
		if err != nil {
			return nil, imagePolicyError(400, "basispoints_image_history_boundary", err.Error())
		}
		if changed {
			if plan.reconciled, err = history.Body(); err != nil {
				return nil, err
			}
			if total, err = basispoints.InlineImageBytes(history.Input, settings.MaxImageMiB); err != nil {
				return nil, &bpsUnsupportedError{err: err}
			}
		}
	}
	n, limit := history.Count, settings.MaxImages
	if plan.compact {
		// 显式 compact 不受张数阈值限制，但输入本身不能超过合计上限
		if total > limitBytes {
			return nil, imagePolicyError(400, "basispoints_image_compaction_too_large", fmt.Sprintf("The compact input itself exceeds %d MiB of decoded images; reduce image sizes or start a new conversation.", settings.MaxTotalMiB))
		}
		plan.maxImages = max(limit, n)
		return plan, nil
	}
	if settings.Policy == "warn" {
		if total > limitBytes {
			return nil, imagePolicyError(400, "basispoints_image_bytes_limit_reached", fmt.Sprintf("Decoded inline images total %.2f MiB, exceeding the %d MiB limit; run compact or reduce image sizes.", float64(total)/(1<<20), settings.MaxTotalMiB))
		}
		if n > limit-settings.CompactReserve {
			return nil, imagePolicyError(400, "basispoints_image_limit_reached", "Image limit reached. Run compact before adding more images.")
		}
		if n >= limit-settings.WarningRemaining && !state.Warned {
			state.Warned = true
			if raw, err := json.Marshal(state); err == nil {
				if ok, err := store.SaveBPSState(ctx, plan.stateScope, "image-policy", &plan.version, raw); err != nil || !ok {
					return nil, imagePolicyError(503, "basispoints_image_policy_state_unavailable", "Image policy session state is unavailable; retry later")
				}
			}
			remaining := limit - settings.CompactReserve - n
			return nil, imagePolicyError(400, "basispoints_image_compact_recommended", fmt.Sprintf("%d additional image slots remain; run compact, or retry to continue.", remaining))
		}
		return plan, nil
	}
	if n <= limit && total <= limitBytes {
		return plan, nil
	}
	if !d.codexClientRequest() {
		// 非 Codex 客户端无法保存压缩窗口：本请求改走原生通道（Key 级“只走 BPS”时由 routeAllowsNative 拒绝）
		return nil, &bpsUnsupportedError{err: imagePolicyError(400, "basispoints_image_auto_compact_unsupported", "Automatic image compaction requires a Codex client; run compact manually")}
	}
	var progress *basispoints.ImageProgress
	if state.Progress.Digest != "" {
		progress = &state.Progress
	}
	split, err := history.Split(progress)
	if err != nil {
		return nil, imagePolicyError(400, "basispoints_image_history_boundary", err.Error())
	}
	if added := basispoints.CountInlineImages(history.Input[split:]); added > limit {
		return nil, imagePolicyError(400, "basispoints_image_batch_too_large", fmt.Sprintf("%d new images exceed the per-request limit of %d; send fewer images.", added, limit))
	}
	if split == 0 || basispoints.CountInlineImages(history.Input[:split]) > limit {
		return nil, imagePolicyError(400, "basispoints_image_history_limit", "Existing history exceeds the compaction image limit; run compact manually or start a new conversation")
	}
	added, err := basispoints.InlineImageBytes(history.Input[split:], settings.MaxImageMiB)
	if err != nil {
		return nil, &bpsUnsupportedError{err: err}
	}
	if added > limitBytes {
		return nil, imagePolicyError(400, "basispoints_image_batch_too_large", "New images alone exceed the byte limit; compacting history cannot reduce them. Resize or split the new images.")
	}
	if total-added > limitBytes {
		return nil, imagePolicyError(400, "basispoints_image_history_limit", "History images alone exceed the byte limit; reduce historical image sizes or start a new conversation.")
	}
	if len(plan.checkpoints) >= 16 {
		return nil, imagePolicyError(400, "basispoints_image_checkpoint_limit", "Run compact manually to reset the image history checkpoint chain")
	}
	plan.split = split
	plan.maxImages = n
	return plan, nil
}

// finishBPSImages 在 BPS 响应成功交付后保存会话进度（显式 compact 清空检查点链）；低于提醒阈值时清除已提醒标记。
func (s *Server) finishBPSImages(ctx context.Context, plan *bpsImagePlan, window []any) {
	if plan == nil || plan.stateScope == "" || s.bps.disk == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	checkpoints := plan.checkpoints
	if plan.compact {
		checkpoints = nil
	}
	if len(window) > 0 && plan.split > 0 {
		if checkpoint, err := plan.history.Checkpoint(plan.split, window); err == nil {
			checkpoints = append(append([]basispoints.ImageCheckpoint{}, checkpoints...), checkpoint)
		}
	}
	state := bpsImageState{Progress: plan.history.Progress(), Checkpoints: checkpoints}
	var previous bpsImageState
	if json.Unmarshal(plan.previous, &previous) == nil && previous.Warned && plan.history.Count >= plan.settings.MaxImages-plan.settings.WarningRemaining && len(window) == 0 && !plan.compact {
		state.Warned = true
	}
	if raw, err := json.Marshal(state); err == nil {
		_, _ = s.bps.disk.SaveBPSState(ctx, plan.stateScope, "image-policy", nil, raw)
	}
}

type bpsUpload func(ctx context.Context, images *basispoints.NativeImages) ([]byte, *http.Response, error)

// bpsAttachmentUploader 上传一个请求计划中的图片。上传被拒时返回可交给执行链分类的失败响应；
// 附件 429 在同一账号上等待 Retry-After（1–5 秒）后重试一次，整个请求共用这一次（对齐 sub2api）。
func (s *Server) bpsAttachmentUploader(client *http.Client, account Account) bpsUpload {
	var mu sync.Mutex
	retried := false
	return func(ctx context.Context, images *basispoints.NativeImages) ([]byte, *http.Response, error) {
		var rejected *http.Response
		body, err := images.Upload(ctx, &s.bps.uploader, func(ctx context.Context, image basispoints.InlineAttachment) (string, error) {
			id, failed, err := s.uploadBPSAttachment(ctx, client, account, image)
			if failed != nil && failed.StatusCode == http.StatusTooManyRequests {
				mu.Lock()
				retry := !retried
				retried = true
				mu.Unlock()
				if retry {
					if sleepContext(ctx, bpsAttachmentRetryDelay(failed.Header.Get("Retry-After"))) {
						id, failed, err = s.uploadBPSAttachment(ctx, client, account, image)
					}
				}
			}
			if failed != nil {
				failed.Header.Set(bpsEndpointHeader, bpsEndpointAttachments)
				mu.Lock()
				if rejected == nil {
					rejected = failed
				}
				mu.Unlock()
			}
			return id, err
		})
		switch {
		case rejected != nil:
			return nil, rejected, nil
		case errors.Is(err, basispoints.ErrAttachmentBusy):
			return nil, nil, &bpsUnsupportedError{err: err}
		case err != nil:
			return nil, nil, err
		}
		return body, nil, nil
	}
}

func bpsAttachmentRetryDelay(retryAfter string) time.Duration {
	delay := time.Second + time.Duration(rand.IntN(500))*time.Millisecond
	if parsed, ok := parseRetryAfter(retryAfter, time.Now()); ok {
		delay = parsed
	}
	return min(max(delay, time.Second), 5*time.Second)
}

// compactBPSImageHistory 在同一账号上把 Input[:split] 压缩为 BPS 压缩状态，再准备“压缩窗口 + 新输入”的生成请求。
func (s *Server) compactBPSImageHistory(ctx context.Context, client *http.Client, account Account, plan *bpsImagePlan, images *basispoints.NativeImages, bridge *basispoints.Bridge, uploadedBody []byte, upload bpsUpload) ([]byte, *basispoints.Bridge, []any, map[string]any, *http.Response, error) {
	uploaded, err := basispoints.InspectImageHistory(uploadedBody)
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	compactBody, err := uploaded.WithInput(uploaded.Input[:plan.split], true)
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	compactWire, _, err := bridge.Reprepare(compactBody)
	if err != nil {
		return nil, nil, nil, nil, nil, &bpsUnsupportedError{err: err}
	}
	resp, _, err := s.postBPS(ctx, client, account, compactWire)
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, nil, nil, nil, resp, nil
	}
	compacted, err := basispoints.ReadImageCompaction(basispoints.WithProgressTimeout(ctx, resp.Body, time.Duration(s.cfg.BPSStreamIdleSec)*time.Second), nil)
	_ = resp.Body.Close()
	if err != nil {
		var failure *basispoints.UpstreamFailure
		if errors.As(err, &failure) {
			// 压缩轮的上游失败按本次 BPS 尝试处置（限流冷却、换号等）
			raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": failure.Code, "type": failure.Type, "message": failure.Message}})
			status := failure.Status
			if status < 400 {
				status = http.StatusBadGateway
			}
			return nil, nil, nil, nil, &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(raw))}, nil
		}
		return nil, nil, nil, nil, nil, imagePolicyError(502, "basispoints_image_compaction_failed", "Image history compaction did not complete; generation was not started")
	}
	window, _, err := basispoints.CompactWindow(compacted)
	if err != nil {
		return nil, nil, nil, nil, nil, imagePolicyError(502, "basispoints_image_compaction_failed", err.Error())
	}
	tail := plan.history.Input[plan.split:]
	if basispoints.CountInlineImages(window)+basispoints.CountInlineImages(tail) > plan.settings.MaxImages {
		return nil, nil, nil, nil, nil, imagePolicyError(400, "basispoints_image_compaction_insufficient", "Compacted history still exceeds the image limit; reduce new images or compact manually")
	}
	next, err := uploaded.WithInput(append(append([]any{}, window...), tail...), false)
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	continued, err := images.Continue(next, plan.settings.MaxImages)
	if err != nil {
		return nil, nil, nil, nil, nil, imagePolicyError(400, "basispoints_image_compaction_insufficient", "Compacted history plus new images still exceeds the image limits; reduce image sizes or start a new conversation")
	}
	body := next
	if continued.HasImages() {
		var rejected *http.Response
		if body, rejected, err = upload(ctx, continued); rejected != nil || err != nil {
			return nil, nil, nil, nil, rejected, err
		}
	}
	prepared, nextBridge, err := bridge.Reprepare(body)
	if err != nil {
		return nil, nil, nil, nil, nil, &bpsUnsupportedError{err: err}
	}
	usage, _ := compacted["usage"].(map[string]any)
	return prepared, nextBridge, window, usage, nil, nil
}

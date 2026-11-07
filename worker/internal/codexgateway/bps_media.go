package codexgateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/basispoints"
)

// 远程图片（image_url 为 http/https 链接）在走 BPS 前由 Worker 经账号代理下载、校验，
// 改写为内嵌图片后与其他图片一样上传为 BPS 附件（sub2api 原生附件上传方式；不做临时 HTTPS 中转，
// 也不把图片地址交给 BPS）。下载失败时终止当前请求。
const (
	bpsRemoteImageTimeout   = 60 * time.Second
	bpsRemoteImageRedirects = 3
)

// bpsImageError：图片无法下载、不是受支持的图片或超出图片策略，按调用方请求错误交付（不重试、不换号）。
// code 为空时为 invalid_image_url；status 为空时为 400。
type bpsImageError struct {
	code    string
	message string
	status  int
}

func (e *bpsImageError) Error() string { return e.message }

func (e *bpsImageError) errorCode() string {
	if e.code == "" {
		return "invalid_image_url"
	}
	return e.code
}

func (e *bpsImageError) httpStatus() int {
	if e.status == 0 {
		return http.StatusBadRequest
	}
	return e.status
}

// bpsImageHostAllowed 拒绝本机与内网地址（防止经 Worker 访问内部服务）；测试可替换。
var bpsImageHostAllowed = func(host string) bool {
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified())
	}
	return true
}

var bpsImageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// inlineRemoteBPSImages 把消息与工具结果中的远程 input_image 下载为 data URL；同一链接只下载一次。
func (s *Server) inlineRemoteBPSImages(ctx context.Context, client *http.Client, body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte(`"http`)) {
		return body, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var root map[string]any
	if decoder.Decode(&root) != nil {
		return body, nil
	}
	input, _ := root["input"].([]any)
	downloaded := map[string]string{}
	total := 0
	changed := false
	for _, rawItem := range input {
		item, _ := rawItem.(map[string]any)
		for _, field := range []string{"content", "output"} {
			parts, _ := item[field].([]any)
			for _, rawPart := range parts {
				part, _ := rawPart.(map[string]any)
				if part["type"] != "input_image" {
					continue
				}
				link, _ := part["image_url"].(string)
				lower := strings.ToLower(link)
				if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
					continue
				}
				inline, ok := downloaded[link]
				if !ok {
					data, mime, err := s.downloadBPSImage(ctx, client, link)
					if err != nil {
						return nil, err
					}
					if total += len(data); total > basispoints.NativeImageRequestBytes {
						return nil, &bpsImageError{message: "remote images exceed the per-request size limit"}
					}
					inline = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
					downloaded[link] = inline
				}
				part["image_url"] = inline
				changed = true
			}
		}
	}
	if !changed {
		return body, nil
	}
	return json.Marshal(root)
}

func (s *Server) downloadBPSImage(ctx context.Context, client *http.Client, link string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, bpsRemoteImageTimeout)
	defer cancel()
	current := link
	for redirect := 0; ; redirect++ {
		target, err := url.Parse(current)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" || target.User != nil {
			return nil, "", &bpsImageError{message: "remote image URL must be an absolute http(s) URL without credentials"}
		}
		if !bpsImageHostAllowed(target.Hostname()) {
			return nil, "", &bpsImageError{message: "remote image host is not allowed"}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, "", &bpsImageError{message: "remote image URL is invalid"}
		}
		req.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp")
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil && errors.Is(context.Cause(ctx), context.Canceled) {
				return nil, "", ctx.Err()
			}
			return nil, "", &bpsImageError{message: "remote image could not be downloaded"}
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			location := resp.Header.Get("Location")
			_ = resp.Body.Close()
			if location == "" || redirect >= bpsRemoteImageRedirects {
				return nil, "", &bpsImageError{message: "remote image redirects too many times"}
			}
			next, err := target.Parse(location)
			if err != nil {
				return nil, "", &bpsImageError{message: "remote image redirect is invalid"}
			}
			current = next.String()
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, "", &bpsImageError{message: fmt.Sprintf("remote image returned HTTP %d", resp.StatusCode)}
		}
		limit := int64(basispoints.NativeImageMaxMiB) << 20
		data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil {
			return nil, "", &bpsImageError{message: "remote image could not be downloaded"}
		}
		if int64(len(data)) > limit {
			return nil, "", &bpsImageError{message: fmt.Sprintf("remote image exceeds %d MiB", basispoints.NativeImageMaxMiB)}
		}
		// 以内容判定类型（不信任响应头），只接受 PNG / JPEG / GIF / WebP
		mime := http.DetectContentType(data)
		if !bpsImageTypes[mime] {
			return nil, "", &bpsImageError{message: "remote image must be PNG, JPEG, GIF or WebP"}
		}
		return data, mime, nil
	}
}

// bpsProbeRecord 是一次 403 恢复探测（随心跳上报控制面，记入账号的探测记录，不进使用记录、不计费）。
type bpsProbeRecord struct {
	AccountID    string    `json:"account_id"`
	ProbedAt     time.Time `json:"probed_at"`
	Model        string    `json:"model"`
	OK           bool      `json:"ok"`
	Status       int       `json:"status,omitempty"`
	ErrorCode    string    `json:"error_code,omitempty"`
	InputTokens  int64     `json:"input_tokens"`
	OutputTokens int64     `json:"output_tokens"`
	TotalTokens  int64     `json:"total_tokens"`
	DurationMS   int64     `json:"duration_ms"`
}

func (s *Server) recordBPSProbe(record bpsProbeRecord) {
	if _, err := s.events.append(EventProbeRecorded, map[string]string{"runtime_account_id": record.AccountID}, record); err != nil {
		log.Printf("codex-gateway: probe.recorded event not recorded: %v", err)
	}
}

// bpsProbeUsage 从探测的 SSE 正文中取终态用量与错误码。
func bpsProbeUsage(body []byte) (map[string]any, string) {
	var usage map[string]any
	code := ""
	for _, line := range bytes.Split(body, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		var event map[string]any
		if json.Unmarshal(bytes.TrimSpace(line[5:]), &event) != nil {
			continue
		}
		response, _ := event["response"].(map[string]any)
		if value, ok := response["usage"].(map[string]any); ok {
			usage = value
		}
		if failure, ok := response["error"].(map[string]any); ok {
			code, _ = failure["code"].(string)
		}
		if failure, ok := event["error"].(map[string]any); ok && code == "" {
			code, _ = failure["code"].(string)
		}
	}
	return usage, code
}

func usageInt(usage map[string]any, key string) int64 {
	if value, ok := usage[key].(float64); ok && value > 0 {
		return int64(value)
	}
	return 0
}

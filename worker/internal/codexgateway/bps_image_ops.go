package codexgateway

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// BPS 图片端点（对齐 sub2api openai_excel_bps_images.go）：账号 BPS 模型名单含 gpt-image-2 时，
// /v1/images/generations 与 /v1/images/edits 先走 BPS 的 images 端点；BPS 以 400/404/405/413/422 拒绝请求格式时
// （尚未生成任何内容）同一请求改走原生 Codex。只接受实测可用的字段：非流式、png、opaque/auto 背景、
// moderation=auto；编辑必须恰好一张 data URL 图片且无蒙版。
var bpsImageModels = map[string]bool{"gpt-image-2": true}

const (
	bpsImageOpGenerations = "images.generations"
	bpsImageOpEdits       = "images.edits"
)

func bpsImageOperation(operation string) string {
	switch operation {
	case "images", "images.generations":
		return bpsImageOpGenerations
	case "images.edits":
		return bpsImageOpEdits
	}
	return ""
}

// inspectBPSImagesRequest 判定图片请求能否走 BPS；不能时返回空请求（直接走原生）。
func inspectBPSImagesRequest(envelope Envelope, body []byte) bpsRequest {
	op := bpsImageOperation(envelope.Operation)
	if op == "" || !bpsImageModels[envelope.Model] {
		return bpsRequest{}
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return bpsRequest{}
	}
	text := func(name string) string {
		var value string
		_ = json.Unmarshal(fields[name], &value)
		return strings.ToLower(strings.TrimSpace(value))
	}
	var stream bool
	_ = json.Unmarshal(fields["stream"], &stream)
	for _, name := range []string{"partial_images", "output_compression", "style", "input_fidelity", "mask"} {
		if raw, ok := fields[name]; ok && string(raw) != "null" && string(raw) != `""` {
			return bpsRequest{}
		}
	}
	if stream || !oneOf(text("output_format"), "", "png") || !oneOf(text("moderation"), "", "auto") || !oneOf(text("background"), "", "opaque", "auto") {
		return bpsRequest{}
	}
	if op == bpsImageOpEdits {
		if _, _, err := bpsEditImage(fields); err != nil {
			return bpsRequest{}
		}
	}
	return bpsRequest{Supported: true, ImageOp: op}
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

// bpsEditImage 取出唯一一张 data URL 图片（远程地址或多张图片留在原生通道）。
func bpsEditImage(fields map[string]json.RawMessage) ([]byte, string, error) {
	var images []struct {
		ImageURL string `json:"image_url"`
	}
	if json.Unmarshal(fields["images"], &images) != nil || len(images) != 1 {
		return nil, "", errors.New("BPS image edits need exactly one image")
	}
	value := strings.TrimSpace(images[0].ImageURL)
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(header, ";base64") {
		return nil, "", errors.New("BPS image edits need a data URL image")
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(data) == 0 {
		return nil, "", errors.New("invalid image data")
	}
	mime := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	if mime == "" {
		mime = http.DetectContentType(data)
	}
	return data, mime, nil
}

// bpsImagesBody 构造 BPS 图片请求：生成沿用 JSON（去掉 BPS 拒绝的 moderation/stream），编辑改为 multipart。
func bpsImagesBody(op string, body []byte) ([]byte, string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return nil, "", err
	}
	if op == bpsImageOpGenerations {
		delete(fields, "moderation")
		delete(fields, "stream")
		out, err := json.Marshal(fields)
		return out, "application/json", err
	}
	data, mime, err := bpsEditImage(fields)
	if err != nil {
		return nil, "", err
	}
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for _, name := range []string{"model", "prompt", "size", "quality", "background", "output_format"} {
		var value string
		if json.Unmarshal(fields[name], &value) == nil && strings.TrimSpace(value) != "" {
			_ = writer.WriteField(name, strings.TrimSpace(value))
		}
	}
	var n int
	if json.Unmarshal(fields["n"], &n) == nil && n > 1 {
		_ = writer.WriteField("n", strconv.Itoa(n))
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="image"; filename="image.png"`)
	header.Set("Content-Type", mime)
	part, err := writer.CreatePart(header)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(data); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), writer.FormDataContentType(), nil
}

// bpsImagesFallbackStatus：BPS 拒绝请求格式（未生成任何内容），同一请求可改走原生。
func bpsImagesFallbackStatus(status int) bool {
	switch status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return true
	}
	return false
}

func (d *dispatchRun) sendBPSImages(ctx context.Context, account Account) (*http.Response, bool, error) {
	s := d.server
	op := d.bpsRequest.ImageOp
	body, contentType, err := bpsImagesBody(op, d.body)
	if err != nil {
		return nil, false, &bpsUnsupportedError{err: err}
	}
	client, err := s.clientFor(account)
	if err != nil {
		return nil, false, err
	}
	path := "/images/generations"
	if op == bpsImageOpEdits {
		path = "/images/edits"
	}
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) }}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodPost, s.bpsURL(path), bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	setBPSHeaders(req.Header, account, "application/json")
	req.Header.Set("Content-Type", contentType)
	// 图片端点校验完整的 Excel 客户端身份（Responses 只需产品与 agent profile）
	for key, value := range map[string]string{
		"X-Openai-Internal-Basispoints-Client-Platform":       "excel",
		"X-Openai-Internal-Basispoints-Client-Editor":         "excel",
		"X-Openai-Internal-Basispoints-Client-Host":           "office",
		"X-Openai-Internal-Basispoints-Client-Runtime":        "desktop",
		"X-Openai-Internal-Basispoints-Client-Platform-Class": "PC",
		"X-Openai-Internal-Basispoints-Office-Host":           "Excel",
		"X-Openai-Internal-Basispoints-Office-Platform":       "PC",
	} {
		req.Header.Set(key, value)
	}
	req.ContentLength = int64(len(body))
	resp, err := client.Do(req)
	if err != nil {
		return nil, wrote.Load(), err
	}
	if bpsImagesFallbackStatus(resp.StatusCode) {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		_ = resp.Body.Close()
		failure := classifyBPSHTTPFailure(resp.StatusCode, resp.Header, raw, time.Now())
		// 策略拒绝不改走原生（不以换通道规避策略），交给执行链按 BPS 失败处置
		if failure.bpsPolicy == "" && failure.Category != categoryModelUnsupported {
			return nil, false, &bpsUnsupportedError{err: fmt.Errorf("BPS images rejected the request format (%d)", resp.StatusCode), sent: true}
		}
		resp.Body = io.NopCloser(bytes.NewReader(raw))
	}
	if resp.StatusCode >= 300 {
		resp.Header.Set(bpsEndpointHeader, op)
	}
	return resp, true, nil
}

package codexgateway

import (
	"context"
	"crypto/hmac"
	"net/http"
	"time"
)

// Worker 与控制面之间的请求签名（2026-11-07 S4）：双向都用 v1 HMAC（时间窗、随机串、正文摘要）与本进程的内部令牌。
// 同机托管的 Worker 由托管器在每次拉起时给一把随机会话密钥作为内部令牌（KIN_CODEX_GATEWAY_INTERNAL_TOKEN，只在内存与
// 子进程环境里）；外部自启的 Worker 用共用令牌。按实例签发的实例密钥、引导与批准已删除。

// controlCall 记下一次发往控制面的请求所用的令牌与随机串，用来校验控制面的响应签名。
type controlCall struct {
	token  string
	nonce  string
	target string // 请求目标（路径与查询串），控制面按它给响应签名
}

// signInternal 给发往控制面的请求签名（v1）：令牌放在 X-Kin-Gateway-Token，签名串覆盖时间戳、随机串与正文摘要。
func (s *Server) signInternal(req *http.Request, body []byte, token string) controlCall {
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce, _ := randomURLToken(18)
	hash := BodyHash(body)
	call := controlCall{nonce: nonce, target: req.URL.RequestURI()}
	req.Header.Set("X-Kin-Gateway-Timestamp", timestamp)
	req.Header.Set("X-Kin-Gateway-Nonce", nonce)
	req.Header.Set("X-Kin-Gateway-Body-Sha256", hash)
	if token == "" {
		return call
	}
	call.token = token
	req.Header.Set("X-Kin-Gateway-Token", token)
	req.Header.Set("X-Kin-Gateway-Signature", Sign(token, timestamp, nonce, hash, body))
	return call
}

// verifyResponse 校验控制面的响应签名（作用域含状态码与请求目标，绑定本次请求的随机串）：控制面用同一把令牌签名。
// 没有签名或签名不符的响应不采信（策略不应用）。
func (c controlCall) verifyResponse(status int, header http.Header, body []byte) bool {
	if c.token == "" {
		return false
	}
	hash := BodyHash(body)
	if !hmac.Equal([]byte(header.Get("X-Kin-Gateway-Response-Sha256")), []byte(hash)) {
		return false
	}
	want := Sign(c.token, responseSignatureScope(status, c.target), c.nonce, hash, body)
	return hmac.Equal([]byte(want), []byte(header.Get("X-Kin-Gateway-Response-Signature")))
}

type verifiedSecretKey struct{}

// verifiedSecret 是验证本次入站请求所用的令牌（响应签名用同一把，控制面按它验签）。
func verifiedSecret(ctx context.Context, fallback string) string {
	if value, ok := ctx.Value(verifiedSecretKey{}).(string); ok && value != "" {
		return value
	}
	return fallback
}

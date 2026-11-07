package codexgateway

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptrace"
	"sync/atomic"
	"time"
)

// 刷新的通用辅助（2026-11-07 S1b 删除刷新租约后保留的部分）：授权类别、结果不明的判定、令牌指纹与控制面请求签名。
// 刷新结果由 Worker 直接按代次 CAS 写回凭据库（facts_write.go），同一账号的刷新在进程内单飞。

// refreshGrantNative 是凭据库里原生授权的类别（executor_credentials.grant_kind，也是密文附加数据的一部分）。
const refreshGrantNative = "native"

// errRefreshAmbiguous：换票请求已完整发出，却没有拿到响应（超时、断连、读响应失败）；上游可能已经轮换了刷新令牌。
var errRefreshAmbiguous = errors.New("refresh outcome unknown: the request was sent but no complete response arrived")

// tokenFingerprint 是刷新令牌的不可逆短指纹，控制面据此判断副本手里的令牌是否已被其他实例轮换。
func tokenFingerprint(refreshToken string) string {
	if refreshToken == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(refreshToken))
	return hex.EncodeToString(sum[:8])
}

// signControlRequest 按控制面内部接口的约定签名（令牌、时间戳、随机串、正文摘要与 HMAC）。
// 托管 Worker 的内部令牌就是托管器生成的会话密钥（2026-11-07 S4）。
func (s *Server) signControlRequest(req *http.Request, body []byte) controlCall {
	req.Header.Set("Content-Type", "application/json")
	token := s.cfg.ControlPlaneToken
	if token == "" {
		token = s.cfg.InternalToken
	}
	return s.signInternal(req, body, token)
}

func (s *Server) controlClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout}
}

// traceWritten 记录请求是否已完整写出，用于区分“没发出去”（failed，可立即重试）与“结果不明”（ambiguous）。
// 不经过标准 Transport 的连接拿不到这个信号，按没发出处理（与过去相同）。
func traceWritten(req *http.Request) (*http.Request, *atomic.Bool) {
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{WroteRequest: func(info httptrace.WroteRequestInfo) {
		if info.Err == nil {
			wrote.Store(true)
		}
	}}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace)), &wrote
}

// sentButUnanswered 把“已发出、没拿到完整响应”的错误标成 errRefreshAmbiguous。
func sentButUnanswered(wrote *atomic.Bool, err error) error {
	if err != nil && wrote != nil && wrote.Load() {
		return fmt.Errorf("%w: %v", errRefreshAmbiguous, err)
	}
	return err
}

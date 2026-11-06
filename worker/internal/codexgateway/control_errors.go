package codexgateway

import (
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// controlErrorInterval：同一类控制面连接错误最多每 60 秒记一条日志。
const controlErrorInterval = 60 * time.Second

// controlErrorLog 对注册（心跳）请求的网络与 TLS 错误限频记日志（测试服务器验收：控制面证书名称不符等错误此前
// 静默重试，运维看不到原因）。按错误类别限频，期间被压下的次数记在下一条里；日志只含控制面主机与错误摘要，
// 不含请求头（令牌、签名）与正文。零值可用。
type controlErrorLog struct {
	mu         sync.Mutex
	last       map[string]time.Time
	suppressed map[string]int
	now        func() time.Time
	logf       func(format string, args ...any)
}

// controlErrorCategory 把请求错误归类：tls（证书、名称不符、握手失败）、dns、refused、timeout、network。
func controlErrorCategory(err error) string {
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var dnsErr *net.DNSError
	switch {
	case errors.As(err, &unknownAuthority), errors.As(err, &hostname), errors.As(err, &invalid):
		return "tls"
	case errors.As(err, &dnsErr):
		return "dns"
	}
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "tls") || strings.Contains(text, "x509") || strings.Contains(text, "certificate"):
		return "tls"
	case strings.Contains(text, "connection refused"):
		return "refused"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	return "network"
}

// note 记录一次控制面请求错误；返回是否实际写了日志。
func (l *controlErrorLog) note(endpoint string, err error) bool {
	if err == nil {
		return false
	}
	category := controlErrorCategory(err)
	now := time.Now
	if l.now != nil {
		now = l.now
	}
	l.mu.Lock()
	if l.last == nil {
		l.last = map[string]time.Time{}
		l.suppressed = map[string]int{}
	}
	at := now()
	if last, ok := l.last[category]; ok && at.Sub(last) < controlErrorInterval {
		l.suppressed[category]++
		l.mu.Unlock()
		return false
	}
	suppressed := l.suppressed[category]
	l.last[category] = at
	l.suppressed[category] = 0
	l.mu.Unlock()
	host := "control plane"
	if parsed, parseErr := url.Parse(endpoint); parseErr == nil && parsed.Host != "" {
		host = parsed.Host
	}
	// url.Error 的文本带完整请求地址；只取内层错误，主机单独给出
	detail := err
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		detail = urlErr.Err
	}
	summary := strings.Join(strings.Fields(detail.Error()), " ")
	if len(summary) > 300 {
		summary = summary[:300] + "…"
	}
	message := fmt.Sprintf("codex-gateway: control plane registration failed (%s) host=%s: %s", category, host, summary)
	if suppressed > 0 {
		message += fmt.Sprintf(" (%d similar errors suppressed since the last report)", suppressed)
	}
	logf := log.Printf
	if l.logf != nil {
		logf = l.logf
	}
	logf("%s", message)
	return true
}

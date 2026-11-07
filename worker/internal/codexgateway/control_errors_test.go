package codexgateway

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// 测试服务器验收：控制面证书不受信、名称不符时注册（心跳）请求在 TLS 握手阶段失败，此前不打任何日志、静默重试。
// 现在按错误类别限频记一条（60 秒内同类只记一次，压下的次数记在下一条），内容含控制面主机与错误摘要，不含令牌。
func TestRegistrationTLSHandshakeFailureIsLoggedAndRateLimited(t *testing.T) {
	handled := 0
	cp := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handled++
		w.WriteHeader(http.StatusOK)
	}))
	cp.Config.ErrorLog = log.New(io.Discard, "", 0)
	cp.StartTLS()
	t.Cleanup(cp.Close)
	cfg := Config{DataDir: t.TempDir(), InternalToken: "shared-secret-token", InstanceID: "gw-tls", CredentialBundleKey: "bundle", ControlPlaneURL: cp.URL + "/internal/v1/gateway/workers/register"}
	cfg.applyDefaults()
	server, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	clock := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)
	server.controlErrors.now = func() time.Time { return clock }
	server.controlErrors.logf = func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	rejected := false
	for i := 0; i < 3; i++ {
		if server.registerOnce(&rejected) {
			t.Fatal("a failed registration does not ask for an immediate retry")
		}
	}
	if handled != 0 {
		t.Fatalf("the untrusted control plane must not receive the heartbeat: %d", handled)
	}
	if len(lines) != 1 {
		t.Fatalf("one line per minute and category, got %q", lines)
	}
	host := strings.TrimPrefix(cp.URL, "https://")
	if !strings.Contains(lines[0], "(tls)") || !strings.Contains(lines[0], "host="+host) || !strings.Contains(lines[0], "certificate") {
		t.Fatalf("the line names the category, the control plane host and the error: %q", lines[0])
	}
	if strings.Contains(lines[0], "shared-secret-token") || strings.Contains(lines[0], "/internal/v1") {
		t.Fatalf("no token or request target in the line: %q", lines[0])
	}
	clock = clock.Add(controlErrorInterval + time.Second)
	server.registerOnce(&rejected)
	if len(lines) != 2 || !strings.Contains(lines[1], "2 similar errors suppressed") {
		t.Fatalf("after the interval the next error is logged with the suppressed count: %q", lines)
	}
}

func TestControlErrorCategories(t *testing.T) {
	refused := &url.Error{Op: "Post", URL: "http://127.0.0.1:1/x", Err: io.ErrUnexpectedEOF}
	if got := controlErrorCategory(refused); got != "network" {
		t.Fatalf("unexpected category %q", got)
	}
	var l controlErrorLog
	var logged []string
	l.logf = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	if !l.note("http://cp.example:8080/internal/v1/gateway/workers/register", refused) || l.note("http://cp.example:8080/x", refused) {
		t.Fatal("the second error of the same category within the interval is suppressed")
	}
	if !strings.Contains(logged[0], "host=cp.example:8080") || strings.Contains(logged[0], "127.0.0.1:1/x") {
		t.Fatalf("the host comes from the configured URL and the inner error only: %q", logged[0])
	}
}

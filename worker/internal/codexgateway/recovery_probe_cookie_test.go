package codexgateway

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type setCookieTransport struct{}

func (setCookieTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	header := http.Header{}
	header.Add("Set-Cookie", "cf_clearance=fresh; Path=/")
	return &http.Response{StatusCode: 500, Header: header, Body: io.NopCloser(strings.NewReader("{}")), Request: req}, nil
}

// 解冻恢复探测只回放已存 Cookie，不回写响应 Set-Cookie；普通请求照常采集（CPR 6b362a50）。
func TestFreezeRecoveryProbeDoesNotWriteBackCookies(t *testing.T) {
	gw, _, _ := newExecuteServer(t, "http://127.0.0.1:1", account("a", "tok_a"))
	a := mustGet(t, gw, "a")
	transport := &accountCookieTransport{base: setCookieTransport{}, store: gw.store, account: "a", revision: a.CredentialRevision}
	send := func(ctx context.Context) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://chatgpt.com/backend-api/codex/responses", nil)
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	send(withFreezeRecoveryProbe(context.Background()))
	if got := mustGet(t, gw, "a").Cookies; len(got) != 0 {
		t.Fatalf("recovery probe wrote cookies back: %+v", got)
	}
	send(context.Background())
	if got := mustGet(t, gw, "a").Cookies; len(got) != 1 || got[0].Value != "fresh" {
		t.Fatalf("ordinary request should still capture cookies: %+v", got)
	}
}

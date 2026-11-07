package codexgateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// 最终审计 U10a：KIN_CODEX_GATEWAY_RELEASE_CHECK=off 时后台不访问官方发布源；默认开启
func TestReleaseCheckSwitch(t *testing.T) {
	t.Setenv("KIN_CODEX_GATEWAY_INTERNAL_TOKEN", "secret")
	t.Setenv("KIN_CODEX_GATEWAY_DATA_DIR", t.TempDir())
	cfg, err := ConfigFromEnv()
	if err != nil || cfg.DisableReleaseCheck {
		t.Fatalf("release check must default to on: %v %v", cfg.DisableReleaseCheck, err)
	}
	for _, value := range []string{"off", "OFF", "0", "false", "no"} {
		t.Setenv("KIN_CODEX_GATEWAY_RELEASE_CHECK", value)
		if cfg, _ := ConfigFromEnv(); !cfg.DisableReleaseCheck {
			t.Fatalf("KIN_CODEX_GATEWAY_RELEASE_CHECK=%s must disable the release check", value)
		}
	}
	// 拼错或其他值不会静默关闭（复核 R5）
	for _, value := range []string{"on", "1", "enable", "enabled"} {
		t.Setenv("KIN_CODEX_GATEWAY_RELEASE_CHECK", value)
		if cfg, _ := ConfigFromEnv(); cfg.DisableReleaseCheck {
			t.Fatalf("KIN_CODEX_GATEWAY_RELEASE_CHECK=%s must keep the release check on", value)
		}
	}

	run := func(disabled bool) int64 {
		var hits atomic.Int64
		source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			hits.Add(1)
			w.WriteHeader(http.StatusNotFound)
		}))
		defer source.Close()
		server, _, _ := newExecuteServer(t, "http://127.0.0.1:1")
		server.cfg.DisableReleaseCheck = disabled
		server.releaseFetcher.npmURL, server.releaseFetcher.appcastURL = source.URL+"/npm", source.URL+"/appcast.xml"
		server.releaseFetcher.allowHost = func(string) bool { return true }
		server.releaseFetcher.artifact = func(string, string) string { return source.URL + "/artifact" }
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		server.backgroundLoop(ctx)
		return hits.Load()
	}
	if hits := run(true); hits != 0 {
		t.Fatalf("disabled release check reached the release source %d times", hits)
	}
	if hits := run(false); hits == 0 {
		t.Fatal("enabled release check never reached the release source")
	}
}

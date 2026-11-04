package codexgateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestModelCatalogTriesAccountsAndCaches(t *testing.T) {
	var calls atomic.Int32
	var gotVersion, gotUA string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") == "Bearer tok_a" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		gotVersion, gotUA = r.Header.Get("version"), r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","service_tiers":[{"id":"priority","name":"fast"}]}]}`)
	}))
	defer upstream.Close()
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok_a"), account("b", "tok_b"))
	response, out := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/models", map[string]any{"client_version": "0.170.0"})
	catalog, _ := out["catalog"].(map[string]any)
	models, _ := catalog["models"].([]any)
	if response.StatusCode != 200 || len(models) != 1 || calls.Load() != 2 {
		t.Fatalf("status=%d calls=%d out=%v", response.StatusCode, calls.Load(), out)
	}
	if gotVersion != "0.170.0" || !strings.HasPrefix(gotUA, "Codex Desktop/0.170.0 (Mac OS ") {
		t.Fatalf("catalog identity version=%q ua=%q", gotVersion, gotUA)
	}
	_, out = accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/models", map[string]any{"client_version": "0.170.0"})
	if out["cached"] != true || calls.Load() != 2 {
		t.Fatalf("expected cached catalog, calls=%d out=%v", calls.Load(), out)
	}
}

func TestModelCatalogUnavailableIs503(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer upstream.Close()
	_, httpServer, cfg := newExecuteServer(t, upstream.URL, account("a", "tok_a"))
	response, out := accountActionRequest(t, cfg, httpServer.URL, "/internal/v1/models", map[string]any{"client_version": "0.170.0"})
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
}

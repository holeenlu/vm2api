package codexgateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signedGet(t *testing.T, cfg Config, url string) *http.Response {
	t.Helper()
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce := "get-" + url + "-" + timestamp
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("x-kin-gateway-timestamp", timestamp)
	req.Header.Set("x-kin-gateway-nonce", nonce)
	req.Header.Set("x-kin-gateway-body-sha256", BodyHash(nil))
	req.Header.Set("x-kin-gateway-signature", Sign(cfg.InternalToken, timestamp, nonce, BodyHash(nil), nil))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestAccountProfileSubscriptionAndAvatar(t *testing.T) {
	var avatarAuth, subscriptionQuery, subscriptionOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/backend-api/wham/profiles/me":
			_, _ = io.WriteString(w, `{"profile":{"display_name":" Alice ","username":"","profile_picture_url":"https://chatgpt.com/backend-api/estuary/public_content/enc/abc123"},"stats":{"lifetime_tokens":1200,"longest_running_turn_sec":7,"daily_usage_buckets":[{"start_date":"2026-11-02","tokens":5},{"start_date":"2026-11-01","tokens":3}],"top_invocations":[{"type":" skill ","skill_name":"lint","usage_count":4}],"fast_mode_usage_percentage":12.5},"metadata":{"stats_error":" "}}`)
		case "/backend-api/subscriptions":
			subscriptionQuery, subscriptionOrigin = r.URL.RawQuery, r.Header.Get("Origin")
			_, _ = io.WriteString(w, `{"active_start":"2026-10-01T00:00:00Z","active_until":"2026-11-01T00:00:00Z","will_renew":true,"billing_period":"monthly","billing_currency":"USD"}`)
		case "/backend-api/estuary/public_content/enc/abc123":
			avatarAuth = r.Header.Get("Authorization") + "|" + r.Header.Get("chatgpt-account-id") + "|" + r.Header.Get("User-Agent")
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("ETag", `"v1"`)
			_, _ = w.Write(bytes.Repeat([]byte{0x89}, 70000))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	acct := Account{ID: "a", Enabled: true, AccessToken: "tok_a", ChatGPTAccountID: "chatgpt_a", Groups: []string{"1"}}
	_, httpServer, cfg := newExecuteServer(t, upstream.URL+"/backend-api/codex", acct)

	response, out := getJSON(t, cfg, httpServer.URL+"/internal/v1/accounts/a/profile")
	profile, _ := out["profile"].(map[string]any)
	summary, _ := profile["summary"].(map[string]any)
	daily, _ := profile["daily_usage"].([]any)
	if response.StatusCode != 200 || profile["display_name"] != "Alice" || profile["username"] != nil || profile["has_stats_error"] != false || summary["longest_task_duration_ms"] != float64(7000) || len(daily) != 2 || daily[0].(map[string]any)["date"] != "2026-11-01" {
		t.Fatalf("status=%d profile=%v", response.StatusCode, profile)
	}

	_, out = getJSON(t, cfg, httpServer.URL+"/internal/v1/accounts/a/subscription")
	subscription, _ := out["subscription"].(map[string]any)
	if subscription["expires_at"] != "2026-11-01T00:00:00Z" || subscription["will_renew"] != true || subscription["billing_currency"] != "USD" || subscriptionQuery != "account_id=chatgpt_a" || subscriptionOrigin != upstream.URL {
		t.Fatalf("subscription=%v query=%q origin=%q", subscription, subscriptionQuery, subscriptionOrigin)
	}

	avatar := signedGet(t, cfg, httpServer.URL+"/internal/v1/accounts/a/avatar?source="+urlQuery("https://chatgpt.com/backend-api/estuary/public_content/enc/abc123"))
	data, _ := io.ReadAll(avatar.Body)
	avatar.Body.Close()
	if avatar.StatusCode != 200 || avatar.Header.Get("Content-Type") != "image/png" || len(data) != 70000 || avatarAuth != "Bearer tok_a|chatgpt_a|Codex Desktop/26.901.51231 (Mac OS; arm64)" {
		t.Fatalf("avatar status=%d type=%q len=%d auth=%q", avatar.StatusCode, avatar.Header.Get("Content-Type"), len(data), avatarAuth)
	}
	for _, source := range []string{"https://evil.example/backend-api/estuary/public_content/enc/x", "https://chatgpt.com/backend-api/estuary/public_content/enc/x?sig=1", "https://chatgpt.com/other", "https://user@cdn.auth0.com/avatars/x.png"} {
		rejected := signedGet(t, cfg, httpServer.URL+"/internal/v1/accounts/a/avatar?source="+urlQuery(source))
		rejected.Body.Close()
		if rejected.StatusCode != http.StatusBadRequest {
			t.Fatalf("source %s accepted: %d", source, rejected.StatusCode)
		}
	}
}

func urlQuery(value string) string {
	return strings.NewReplacer("%", "%25", "&", "%26", "?", "%3F", "#", "%23", "+", "%2B", "=", "%3D").Replace(value)
}

func getJSON(t *testing.T, cfg Config, url string) (*http.Response, map[string]any) {
	t.Helper()
	response := signedGet(t, cfg, url)
	defer response.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(response.Body).Decode(&out)
	return response, out
}

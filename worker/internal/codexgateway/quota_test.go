package codexgateway

import (
	"testing"
	"time"
)

func TestParseQuotaHeaders(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	evidence := parseQuotaHeaders(map[string][]string{
		"X-Codex-Primary-Used-Percent":          {"80"},
		"X-Codex-Primary-Window-Minutes":        {"10080"},
		"X-Codex-Primary-Reset-After-Seconds":   {"3600"},
		"X-Codex-Secondary-Used-Percent":        {"25"},
		"X-Codex-Secondary-Window-Minutes":      {"300"},
		"X-Codex-Secondary-Reset-After-Seconds": {"120"},
	}, now)
	if evidence.Confidence != "complete" {
		t.Fatalf("confidence=%q", evidence.Confidence)
	}
	if evidence.Primary["window_minutes"] != float64(10080) || evidence.Secondary["window_minutes"] != float64(300) {
		t.Fatalf("unexpected windows: %#v", evidence)
	}
}

func TestQuotaExhaustedUsesFutureReset(t *testing.T) {
	now := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	exhausted, until := quotaExhausted(map[string]any{
		"primary_window": map[string]any{"used_percent": float64(100), "reset_at": now.Add(time.Hour).Format(time.RFC3339Nano)},
	}, now)
	if !exhausted || until.IsZero() {
		t.Fatalf("expected exhausted account, got %v %v", exhausted, until)
	}
}

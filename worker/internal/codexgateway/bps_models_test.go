package codexgateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const bpsAccessFixture = `{"allowed":true,"model_catalog":{"restricted_models":["gpt-secret"],"models":[
{"id":"gpt-5.5","label":"GPT-5.5","efforts":[{"value":"low"},{"value":"high"},{"value":"minimal"},{"value":"high"}]},
{"id":"gpt-secret","label":"hidden"},
{"id":"gpt-off","available":false},
{"id":"gpt-unconfigured","policy":{"state":"unconfigured"}},
{"id":"not a model"},
{"id":"gpt-image-2"}]}}`

func TestParseBPSAccessKeepsOnlyOfficiallyAvailableModels(t *testing.T) {
	catalog, err := parseBPSAccess([]byte(bpsAccessFixture))
	if err != nil {
		t.Fatal(err)
	}
	if !catalog.Allowed || len(catalog.Models) != 2 || catalog.Models[0].ID != "gpt-5.5" || catalog.Models[0].DisplayName != "GPT-5.5" || len(catalog.Restricted) != 1 {
		t.Fatalf("catalog=%+v", catalog)
	}
	if efforts := catalog.Models[0].ReasoningEfforts; len(efforts) != 2 || efforts[0] != "low" || efforts[1] != "high" {
		t.Fatalf("efforts=%v", efforts)
	}
	denied, err := parseBPSAccess([]byte(`{"allowed":false}`))
	if err != nil || denied.Allowed || len(denied.Models) != 0 {
		t.Fatalf("denied=%+v err=%v", denied, err)
	}
	for _, bad := range []string{`{}`, `{"allowed":true}`, `nope`} {
		if _, err := parseBPSAccess([]byte(bad)); err == nil {
			t.Fatalf("%s must be rejected", bad)
		}
	}
}

func TestBPSModelCatalogIsCachedAndOverlaysModelCooldowns(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bps/responses/access" || r.URL.RawQuery != "include_models=true" || r.Header.Get("Authorization") != "Bearer bps_tok_a" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		calls++
		_, _ = io.WriteString(w, bpsAccessFixture)
	}))
	t.Cleanup(upstream.Close)
	account := bpsAccount("a", "tok_a")
	account.BPS.ModelCooldowns = map[string]time.Time{"gpt-5.5": time.Now().Add(time.Hour)}
	s, _, _ := newBPSExecuteServer(t, upstream.URL, account)
	stored, _ := s.store.Get("a")
	for i := 0; i < 2; i++ {
		catalog, err := s.bpsModelCatalog(context.Background(), stored, false)
		if err != nil || len(catalog.Models) != 2 || !catalog.Models[0].CoolingDown {
			t.Fatalf("catalog=%+v err=%v", catalog, err)
		}
	}
	if calls != 1 {
		t.Fatalf("catalog must be cached, calls=%d", calls)
	}
	if _, err := s.bpsModelCatalog(context.Background(), stored, true); err != nil || calls != 2 {
		t.Fatalf("refresh must refetch: calls=%d err=%v", calls, err)
	}
}

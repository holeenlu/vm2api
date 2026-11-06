package codexgateway

import (
	"bytes"
	"net/http"
	"os"
	"testing"
)

// 内嵌的设置描述必须与控制面使用的源文件逐字节一致
func TestEmbeddedSettingsSchemasMatchTheControlPlaneCopies(t *testing.T) {
	for _, name := range []string{"codex-settings.json", "codex-account.json"} {
		source, err := os.ReadFile("../../../src/shared/executor-schema/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(source, schemaDocument(name)) {
			t.Fatalf("%s differs from src/shared/executor-schema; copy it into worker/internal/codexgateway/schema", name)
		}
		if schemaVersion(name) < 1 {
			t.Fatalf("%s has no version", name)
		}
	}
	_, httpServer, cfg := newBPSExecuteServer(t, "http://127.0.0.1:1")
	response, out := signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/schema/settings", nil)
	if response.StatusCode != http.StatusOK || out["scope"] != "codex" || out["version"].(float64) < 1 {
		t.Fatalf("status=%d out=%v", response.StatusCode, out)
	}
	_, capabilities := signedInternal(t, cfg, http.MethodGet, httpServer.URL+"/internal/v1/capabilities", nil)
	if schema, _ := capabilities["account_schema"].(map[string]any); schema == nil || schema["url"] != "/internal/v1/schema/account" {
		t.Fatalf("capabilities=%v", capabilities)
	}
}

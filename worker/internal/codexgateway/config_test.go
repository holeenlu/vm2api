package codexgateway

import (
	"strings"
	"testing"
)

func TestConfigRejectsPlaintextOutsideLoopback(t *testing.T) {
	cfg := Config{Listen: "0.0.0.0:8790", InternalToken: "secret"}
	cfg.applyDefaults()
	cfg.AllowInsecure = false
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "listen on a loopback address") {
		t.Fatalf("expected plaintext transport rejection, got %v", err)
	}
}

func TestConfigRequiresSharedCredentialKeyWithAControlPlane(t *testing.T) {
	cfg := Config{Listen: "127.0.0.1:8790", InternalToken: "secret", ControlPlaneURL: "http://127.0.0.1:8787/internal/v1/gateway/workers/register"}
	cfg.applyDefaults()
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "credential_bundle_key") {
		t.Fatalf("expected shared credential key requirement, got %v", err)
	}
}

func TestConfigRejectsInvalidInstanceIDs(t *testing.T) {
	for _, id := range []string{"gw 1", "-gw", "gw/1", strings.Repeat("a", 65)} {
		cfg := Config{DataDir: t.TempDir(), InternalToken: "x", InstanceID: id}
		cfg.applyDefaults()
		if err := cfg.Validate(); err == nil {
			t.Fatalf("instance id %q must be rejected", id)
		}
	}
	cfg := Config{DataDir: t.TempDir(), InternalToken: "x", InstanceID: "  gw-01 "}
	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil || cfg.InstanceID != "gw-01" {
		t.Fatalf("surrounding spaces are trimmed: %v %q", err, cfg.InstanceID)
	}
}

package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/codexgateway"
)

func main() {
	configPath := flag.String("config", os.Getenv("KIN_CODEX_GATEWAY_CONFIG"), "path to gateway worker JSON config")
	unseal := flag.Bool("unseal-accounts", false, "rewrite the encrypted account store as plaintext and exit (only for rolling back to a Worker without at-rest encryption; stop the Worker first)")
	flag.Parse()
	var cfg codexgateway.Config
	var err error
	if *configPath != "" {
		cfg, err = codexgateway.LoadConfig(*configPath)
	} else {
		cfg, err = codexgateway.ConfigFromEnv()
	}
	if err != nil {
		log.Fatal(err)
	}
	if *unseal {
		if err := codexgateway.UnsealAccountStore(cfg.AccountsPath(), cfg.CredentialBundleKey); err != nil {
			log.Fatal(err)
		}
		log.Printf("account store rewritten as plaintext: %s", cfg.AccountsPath())
		return
	}
	server, err := codexgateway.NewServer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := server.Serve(ctx); err != nil && err != context.Canceled {
		log.Fatal(err)
	}
}

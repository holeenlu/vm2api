package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/codexgateway"
)

func main() {
	configPath := flag.String("config", os.Getenv("KIN_CODEX_GATEWAY_CONFIG"), "path to gateway worker JSON config")
	unseal := flag.Bool("unseal-accounts", false, "rewrite the encrypted account store as plaintext and exit (only for rolling back to a Worker without at-rest encryption; stop the Worker first)")
	renamePlan := flag.String("rename-accounts", "", "rename runtime accounts offline per the control-plane rename plan JSON and exit (stop every Worker first; see docs/GATEWAY_ACCOUNT_ID_RENAME.md)")
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
	if *renamePlan != "" {
		renames, err := codexgateway.LoadAccountRenamePlan(*renamePlan)
		if err != nil {
			log.Fatal(err)
		}
		report, err := codexgateway.RenameAccounts(cfg, renames)
		out, _ := json.MarshalIndent(report, "", "  ")
		fmt.Println(string(out))
		if err != nil {
			log.Fatal(err)
		}
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

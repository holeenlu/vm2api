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

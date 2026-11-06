// Command miniredis-server 只供 e2e 使用（统一控制面重构 P5.5）：在指定地址启动内存 Redis（miniredis），
// 打印 "ready <地址>" 后一直运行到收到 SIGTERM/SIGINT。生产部署使用真实 Redis。
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/alicebob/miniredis/v2"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	flag.Parse()
	server := miniredis.NewMiniRedis()
	if err := server.StartAddr(*addr); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("ready %s\n", server.Addr())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	<-signals
	server.Close()
}

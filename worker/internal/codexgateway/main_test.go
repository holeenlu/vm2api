package codexgateway

import (
	"os"
	"testing"
	"time"
)

// 测试中运行时状态同步落盘：延迟落盘的计时器不能在用例结束、临时目录正在删除时写入文件。
// 需要验证延迟落盘的用例用 withRuntimeFlushDelay 临时开启。
func TestMain(m *testing.M) {
	runtimeFlushDelay = 0
	os.Exit(m.Run())
}

func withRuntimeFlushDelay(t *testing.T, delay time.Duration) {
	t.Helper()
	previous := runtimeFlushDelay
	runtimeFlushDelay = delay
	t.Cleanup(func() { runtimeFlushDelay = previous })
}

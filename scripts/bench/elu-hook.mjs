// 预加载到网关子进程（NODE_OPTIONS=--import）：每 250ms 把主线程事件循环利用率（ELU）
// 追加到 KIN_BENCH_ELU_FILE。只在压测时加载，生产进程不会读取这个文件。
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const file = process.env.KIN_BENCH_ELU_FILE
if (file) {
  let last = performance.eventLoopUtilization()
  setInterval(() => {
    const now = performance.eventLoopUtilization()
    const d = performance.eventLoopUtilization(now, last)
    last = now
    fs.appendFileSync(file, `${Date.now()} ${d.utilization.toFixed(4)}\n`)
  }, 250).unref()
}

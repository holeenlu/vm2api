# routing.json 调度段校验

更新日期：2026-11-07（审计阶段 2 W11）。

`routing.json` 的 `pool`、`sticky`、`quota`、`concurrency`、`failover` 五段由描述文件 [`src/shared/executor-schema/routing-pool.json`](../src/shared/executor-schema/routing-pool.json) 统一定义字段、类型、范围与枚举，控制面在 `src/lib/admin/routing-schema.mjs` 中复用 `validateAgainstSchema`（与 Codex 执行设置同一套校验）。

## 保存

`PUT /api/panel/routing`、`PUT /admin/routing` 与内部 `persistRoutingPatch` 在写入前校验上述五段：

- 未知键返回 400 `invalid_routing_config`，`error.errors` 为 `[{ field, reason }]`，例如 `{ "field": "failover.max_total_attempt", "reason": "unknown setting" }`。
- 类型、范围或枚举不符同样返回 400，例如 `pool.strategy` 只接受 `balanced`、`fill`（以前拼错会静默变成 `balanced`）。
- 校验在任何副作用之前进行：面板路由在切换推理引擎前校验，`persistRoutingPatch` 在写文件和推进 `config_revision` 前校验，失败不改动配置。
- 面板保存时会把整段回传；加载时已修复的值都在范围内，所以正常保存不会被拒绝。

其他段（`compatibility`、`inference`、`codex`、`vm`、`logging`、`relay_billing` 等）仍由各自的规范化与校验函数负责。

## 加载

`loadRoutingConfig`（启动、恢复备份后重新加载）先修复五段，再交给原有规范化：

- 超出范围的数值截断到边界，小数按整数字段取整，数字字符串按数值处理。
- 其他非法值回到描述中的 `default`；没有 `default` 的字段（`sticky.header_keys`、`sticky.body_keys`、`failover.stream_keepalive_ms`、`failover.max_attempts`、`failover.max_switches`）删除，由使用方取内置默认。
- 未知键删除。
- 每个问题写一条 `{"event":"routing_config_invalid","field","reason","action"}`（`action` 为 `clamped`、`default` 或 `removed`），同一进程内只写一次；不阻断启动，内存中的配置在下次保存时写回磁盘。

`pool.worker_health_ttl_ms` 同时是 Worker 健康缓存有效期和调度器维护定时器的间隔。以前非数字值会让 `Math.max(1000, NaN)` 得到 NaN，`setInterval` 退化为约 1ms 的紧循环、健康缓存永不命中；现在加载时与 `normalizePoolConfig` 都把它限定在 1000–60000 ms，非法值取 5000。

## 已知不生效的字段

- `pool.seat_grace_ms`：上游原有字段，面板“席位”对话框可以编辑并保存（0–120000 ms），但席位规划不使用它（`pool-scheduler.mjs` 构造 `SeatPlanner` 时传 0，`reloadConfig` 传入的值也只被保存，`seat-planner.mjs` 注明 `graceMs` unused）。按“上游优先”保留，不删除；上游删除或启用后随同步处理。
- `pool.heartbeat_stale_ms`：随默认 `routing.json` 发布，当前没有读取方，仅按范围校验。

## 额度周期

用户决定（2026-11-07）：保留按时长计算的额度窗口，不改为自然日、周、月，并在界面写明。两类额度的口径不同：

- 套餐（分组 `daily_limit_usd` / `weekly_limit_usd` / `monthly_limit_usd`，`relay-billing.mjs` `SUBSCRIPTION_PERIODS`）是真正的滚动窗口：每次准入统计从当前时刻往回 24 小时、7 天、30 天内的扣费。分组编辑页与套餐页标为“24 小时（滚动）”“7 天（滚动）”“30 天（滚动）”。
- Key（`rate_limit_5h` / `rate_limit_1d` / `rate_limit_7d`，`api-keys-repo.mjs` `_rollWindow`，沿用 sub2api 语义）从窗口内第一笔消费开始计时，满 5 小时、24 小时、7 天后清零重新开始，不是逐笔回溯的滚动窗口。Key 编辑页标为“24 小时（首笔起算）”等，并在用量限制说明里写明。

两者都不按自然日、周、月重置；统计页的“今日”等数字按 Asia/Shanghai 自然日。四种语言（zh-CN、zh-TW、en-US、ja-JP）文案一致。

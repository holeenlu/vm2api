# PF.2 整体终审报告与处置

范围：重构前基线 `efa16635` 到交付提交 `f48712fd` 的全部改动（两者都是上游 `6a8f9c7f` 上的单一定制提交）。两个独立审查智能体，新上下文、只读，检出固定在 `/private/tmp/cp-review-PF`：

- 审查 A：正确性与计费；
- 审查 B：安全与上游同步成本。

结论：A 有 1 项 P1、9 项 P2；B 有 2 项 P1、7 项 P2；没有 P0。三项 P1 在开关默认关闭时都不会触发，但都是 P1.10 / P3.10 生产切换的前提，已全部修复。

## 审查 A：正确性与计费

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| A1 | P1 | 回放比对工具只做“事件 → 回执”单向比对，两边字段源自同一份回执，必然一致；发现不了事件丢失与计费差异；收件箱问题状态不计入退出码 | 已修复。`scripts/executor-replay-diff.mjs` 增加“回执 → 事件”（已开始消费事件的实例，回执必须有对应事件，最近 5 分钟记为待到达）与“回执 → 账本”（用量可信度、token、成本）；`invalid` / `failed` / `missing` / `diff` 计入退出码；ACCEPTANCE 第 2 条按工具实际能力改写。测试：`replay diff finds receipts without events, ledger mismatches and invalid inbox rows` |
| A2 | P2 | 信封无效的 `request.finalized` 让比对工具崩溃；shadow `compare` 遇到缺 `dispatch_id` 的载荷会抛错卡住事件流 | 已修复。比对工具从信封里取载荷，缺 `dispatch_id` 记为 `invalid_event`；`compare` 先校验载荷，缺字段记为 `invalid` |
| A3 | P2 | Worker 数据目录从旧快照恢复后，复用序号的新事件被静默跳过，链路仍判健康 | 已修复（控制面侧）。每次拉取多取游标所在的那一条，内容不同或 Worker head 小于游标即判回滚，从 Worker 已确认处重新处理；同一 `event_id` 内容不同的事件以派生 ID 入库；游标超过 Worker head 时链路不算健康。测试：`a Worker event log restored from an old snapshot is detected and its new events are processed` |
| A4 | P2 | `account.state` 过时判断按字符串比较可变小数位的时间 | 已修复。按纳秒数值比较（`timeNanos`）；不按序号比较（回滚后新事件会复用较小的序号）。测试：`account snapshots compare times numerically across variable fraction digits` |
| A5 | P2 | shadow 也会因事件日志故障让 Worker 拒单；毒事件永久卡住事件流 | 已修复。心跳策略新增 `executor_events.enforce`（只有 primary 为真），旧版控制面不下发时与 `required` 相同；同一事件连续失败 5 次记为 `failed` 并跳过。测试：Go `TestUnconsumedEventLogSelfAcknowledgesAndNeverBlocks`（shadow 不拒单）、Node `a poison event is skipped after repeated failures` |
| A6 | P2 | 默认关闭时每个请求收尾都在全局锁内 fsync | 已修复。控制面明确不消费（`required` 为否）时不逐条 fsync；必需或未知时照常 |
| A7 | P2 | 事件补写的尝试会落到没有使用记录的分发、或写到回退 VM 的尝试行上 | 已修复。已有非 Gateway 尝试行时不补写；没有实时行也没有使用记录时不生成。测试：`event attempts only complete client requests and never touch VM attempt rows` |
| A8 | P2 | 设置快照的版本与值分两条语句读取 | 已修复。版本取设置行自身的 `revision` |
| A9 | P2 | control 托管仍依赖在线的来源 Worker 导出 | 接受，写入设计 6.2“已知限制”，退出条件为凭据库令牌加控制面账号配置直接投影；P3.10 前评估 |
| A10 | P2 | 关闭到开启切换窗口内可能丢失 `account.state` | 已修复。`required` 转为“是”时 Worker 补发一份完整账号终态快照。测试：`TestStartingConsumptionResendsTheAccountStateSnapshot` |

## 审查 B：安全与上游同步

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| B1 | P1 | Worker 启动后、首个心跳策略前，刷新不经租约（租约开关无“未知”状态） | 已修复。租约策略改为三态并落盘（`refresh-lease-policy`），重启沿用；全新 Worker 在策略未知时不做定时刷新，请求内刷新先申请租约，只有控制面是不支持租约的旧版本（接口 404 且不是“实例未注册”）时才自行刷新。测试：`TestUnknownLeasePolicyNeverRefreshesWithoutALease` |
| B2 | P1 | control 模式下新实例 ID 首次登记的托管公钥被自动信任，只泄露内部令牌即可拿到全部明文令牌 | 已修复。所有上报的公钥（含新实例的首个）先待确认，管理员核对指纹后才固定；控制面自己拉起的同机 Worker 由控制面从本机数据目录读出公钥自动确认；注册请求不能自报 `admission_state`。界面区分“首次上报”与“替换”。设计 6.2 信任边界与运维文档第 10 节改写。测试：`a new instance custody key waits for confirmation unless it is the supervised local Worker`；双 Worker e2e 先确认两个实例的首个公钥 |
| B3 | P2 | 响应签名不覆盖查询串；序号缺口照样确认；导出响应不签名 | 已修复。签名域改为完整请求目标；序号缺口先不确认、连续 5 轮仍在才接受；导出响应签名，控制面对报告 `signed_exports` 能力的 Worker 验签（旧版 Worker 兼容，移除条件：所有 Worker 都报告该能力）。测试：`gateway-response-signature`（查询串被签）、`a sequence gap is retried before it is accepted and acknowledged`、Go 事件页签名测试 |
| B4 | P2 | 凭据库保存的 `proxy_url` 会过时并随投影下发 | 已修复。凭据库不再保存代理；托管封装的代理取来源实例当前的凭据包，旧记录里的值被覆盖。测试：`control custody takes the proxy from the source and never exports a stale vault copy` |
| B5 | P2 | control 模式导出账号文件不检查凭据库是否比 Worker 旧 | 已修复。导出前先收录；凭据库仍旧时用 Worker 副本。测试同上 |
| B6 | P2 | 授权会话只有配置数据库密钥时才加密，文档写无条件加密 | 文档更正（设计 6.3、运维第 10 节），会话 10 分钟过期、完成或过期后清空 |
| B7 | P2 | 迁移演练会生成主密钥文件；首次创建主密钥文件无防覆盖 | 已修复。演练在没有主密钥文件、也没有记录时按空凭据库比较，不创建文件；首次创建改为排他写入（硬链接），竞争失败的一方读取已存在的文件；运维文档写明脚本须带同一个 `KIN_CREDENTIAL_MASTER_KEY_FILE`。测试：`a dry-run migration creates no master key file and first creation never overwrites one` |
| B8 | P2 | 凭据库解密失败时投影中断，与文档不一致 | 保持拒绝投影（偏安全），增加一次性告警，并写入运维文档 |
| B9 | P2 | `supplier-platform/18-…md` 残留 `routing.codex.*` 旧描述 | 已修复。改为“Codex 执行设置”（控制面设置存储）；`PANEL_API.md` 的默认系数与代码一致（5 项） |

上游触点（审查 B 统计，`efa16635 → f48712fd`）：20 个上游文件，+135 −280，相对上游净减；`codex-route.mjs` 恢复为上游原样。本轮修复只改定制文件。

## 终审复核（提交 `efd3c996`）

两次交付之间远端被另一任务推进过（CPR 同步，`fe543b58`），本轮修复以它为基线三方合并后交付；复核对照 `fe543b58..efd3c996`。

- **审查 B：复核通过。** B1–B9 全部成立，两项 P1 关闭。新提出 3 项 P2，已处理：
  - B-N1：策略未知时识别旧版控制面改为正向判断（通用 404、不带任何错误码），新版控制面带错误码的 404（如账号绑定不存在）不再被当成旧版本。测试补在 `TestUnknownLeasePolicyNeverRefreshesWithoutALease`；
  - B-N2：接控制面时定时刷新一律等本次启动收到的第一份心跳策略，落盘的策略只用于请求内刷新（开启租约时重启的 Worker 不会按旧的 off 定时刷新）；
  - B-N3：运维文档第 10 节启用步骤加入“核对已固定公钥的实例，删除不认识的实例”（B2 修复前自动固定的公钥不会被迁移改回待确认）；
  - 另：主密钥文件首次创建在不支持硬链接的文件系统上回退为直接排他创建。
- **审查 A：** A1–A10 中 9 项成立；A7 修复成立但引入 A-N1（P2）：补写按设计跳过的请求（账号测试对话、已回退 VM）仍被记为 `done`，比对工具报假的尝试差异。已修复：`applyFinalizedAttempts` 返回跳过原因，补写状态记为 `not_client`；比对工具对没有使用记录或已有 VM 尝试的请求不比较尝试条数（测试 `replay diff does not compare attempts for non-client dispatches or VM fallbacks`）。审查 A 的两条次要建议一并处理：账本检查增加结算状态（对账进入死信、回执到达 1 小时后仍待结算）；“回执 → 事件”只检查各实例事件消费窗口内的回执（切回 off 后不再报缺事件）。审查 A 第二轮复核（`c8b6a8e7`）：A-N1 与结算状态检查成立；消费窗口终点按最后一条收件计算，会在事件日志持续故障时漏报缺事件（A-N2，P2）。已修复：窗口终点改为控制面最后一次成功拉取该实例的时刻（`executor_event_cursors.updated_at`），测试 `replay diff ends the consumption window at the last pull and reports settlement gaps` 覆盖“仍在拉取但尾部缺事件要报”“切回 off 后不报”与死信、超时待结算。工具说明写明已知盲区：有回执、用量完整但控制面没有使用记录的分发，需从回执表单独核查。审查 A 第三轮复核（`934b14dd`）：**PF.2 审查 A 复核通过**，A1–A10、A-N1、A-N2 全部关闭。按建议在工具说明补充“事件日志长时间故障时调大 `--since-hours` 或查看事件水位”。

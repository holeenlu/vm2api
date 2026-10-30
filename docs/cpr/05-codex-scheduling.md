# GPT/Codex VM 调度：实现契约与验收

更新：2026-10-30。参考 CPR 本地 `12771aca` 的账号选择、容量等待、发送事实、续写归属与健康反馈；本轮普通需求保持 vm2api 当前上游父提交，不同步上游。不复制 CPR 插件 Runtime，不引入 Redis。采用其边界设计，保留 VM、商业分组、节点、代理和 kernel 架构。

## 已落地范围

| 顺序 | 行为 | 关键实现 |
| --- | --- | --- |
| 1 | Responses/Chat/Completions 的每次实际 kernel 调用共享预算；修复重试也计数，取消和派发截止后不再发送 | `handle-codex.mjs` |
| 1 | 发送不明禁止自动重放；已发送的普通 5xx 不视为未执行；明确拒绝或内部安全证明才允许重试 | `codex-replay.mjs` |
| 1 | 增量续写按请求 Key 范围与 response ID 哈希查持久归属；未知、过期、跨 Key、账号身份变化时返回 409 | `codex-response-owners-repo.mjs`、迁移 071 |
| 2 | 未知、null、过期窗口不再作为满额评分，已观测的零用量仍为满额 | `codex-slot-pool.mjs` |
| 2 | 唤醒后的票据在实际占用前仍保留优先权，取消/超时/失败清理释放票据；新请求不得抢位 | `openai-account-runtime.mjs` |
| 2 | 取消、发送不明、传输故障及请求错误不降账号健康分；容量拒绝使用独立反馈类型 | `codex-replay.mjs` |
| 3 | GPT kernel 每次调用写入现有 attempt ledger，记录发送事实、真实下游提交、用量和耗时 | `RequestAttemptsRepo` |
| 3 | GPT 使用既有账号保护策略与 SQLite CAS；新请求读取冻结事实，凭据/策略变化开启新代次，迟到结果不覆盖手动解除 | `codex-account-protection.mjs` |
| 3 | 设置 → OpenAI 新增选号策略、亲和模式和六项 Smart 权重，四语显示；默认维持 Smart/preferred | `codex.scheduling` |

Images/Search 复用本轮选号、额度和公平准入组件，但其原生 HTTP 执行不冒充 kernel attempt。完整诊断 ZIP、后台自动恢复探测、跨控制面租约仍未实现。现有账号保护默认关闭，不因升级自动启用。

## 选号与配置

先执行授权、模型、凭据、额度、工作时间与保护资格，再遵循会话亲和。普通选择按最高账号权重、最小商业分组优先级分档，最后使用档内算法；高权重是资源层级，不是流量比例。

通过现有 `GET/PUT /api/panel/routing` 读写，提交时携带读取到的 `config_revision`：

```json
{
  "codex": {
    "scheduling": {
      "strategy": "smart",
      "affinity": "preferred",
      "smart_weights": {
        "load": 1,
        "quota": 0.8,
        "health": 1,
        "latency": 0.5,
        "reset": 0,
        "queue": 0
      }
    }
  }
}
```

- `strategy`：`smart` / `quota_reset_priority` / `round_robin` / `sticky`。最后一种优先最近使用账号，不等同于会话绑定。
- `affinity`：`strict` 在仍可服务但繁忙的原账号上等待；`preferred` 优先原账号但允许分流；`relaxed` 不优先普通会话绑定。三者都不得改变增量续写的 response owner。
- 六项系数为 0–10 的一位小数，至少一项大于零。默认前四项与旧实现相同，新增 reset/queue 默认零，不宣称默认性能提高。
- `reset` 对未来重置时间评分，距离一小时为半分；未知/过期不给奖励。`queue` 大于零时，用基础分加 `queue/(1+队长)` 选择等待账号，FIFO 优先权仍保留；零时仍等待任一合格账号。
- 输入验证在保存前执行，非法值返回 400。更新部分 `smart_weights` 保留其他已保存系数。请求中的 routing 使用独立副本；撤销授权仍在派发前实时复核。

## 重试与结算边界

`max_total_attempts` 现在限制实际 Node→Codex kernel 调用，不再遗漏 helper 内部重试。`max_same_account_retries` 包含同账号恢复/修复调用；`max_account_switches` 约束账号切换。每次同账号重试仍消耗该账号 RPM，持有同一个并发租约，不重复占槽。

`total_retry_deadline_ms` 从入口时间限制后续派发和重试等待。已开始的生成继续服从原有 first-byte/idle 超时，不把长输出截断成固定 120 秒。节点/原生 kernel 内部若另有不可见重试，不会被虚报成 Node 已观测的调用。

发送状态与 HTTP 错误分类独立：`ambiguous` 禁止自动重放，即便尚未给客户端输出；`sent` 只有明确的认证/额度/容量拒绝或内部 `replaySafe` 证明才能重试。普通 500/502、网络断开和超时不因“客户端没看到输出”而被认定安全。取消、外部副作用和已提交输出继续阻止重放。

attempt ledger 是诊断事实，不是第二套客户扣费账本；既有 request 级结算入口保持。历史记录不补造发送状态或响应归属。

## 续写持久化与升级

迁移 `071_codex_response_owners.sql` 只新增响应归属表。记录 Key/用户/分组范围哈希、响应 ID 哈希、VM、账号身份哈希、出站 session 与 24 小时有效期，不保存密钥、正文或 OAuth token。同一响应归属不可被另一个 VM 或身份覆盖。具备上游账号 ID 时允许正常令牌刷新；缺少可靠账号 ID 时使用凭据摘要，旋转后保守拒绝旧续写。

**行为收紧：** 升级前产生而没有归属记录的 `previous_response_id`、过期记录、跨 Key 使用、账号替换或资源授权撤销，不能随机换号继续。客户端应提交完整历史重新开始，不应对同一增量请求盲重试。普通完整历史请求不依赖该表。

冻结状态使用现有 `account_runtime`；规则字段仍为 provider/status/code/type/message，GPT provider 为 `openai`，管理接口和手动 generation CAS 清除复用已有路径。读取持久状态保证单控制面重启后仍有冻结事实；在途并发和短期反馈仍是进程内状态，不宣称支持多控制面共享容量。

## 验证与未执行操作

- 定向回归覆盖选号、额度/credits、过期观测、三种亲和、系数缩放与校验、排队防抢位、取消、重试预算和 deadline、发送不明拒绝重放。
- 真实 SQLite 覆盖 070→071 升级、历史迁移/日志不变、重复打开、不可改写 owner、Key 隔离与过期；协议入口覆盖无 sticky 续写、账号替换拒绝、GPT 保护跨运行态重建。
- 前端检查类型、设置页四语、控件渲染和实际浏览器策略/亲和/权重交互。
- 不执行真实供应商推理、生产数据库迁移、发版或部署。回退代码须评估已保存新策略以及更严格续写契约，不删除既有历史迁移。

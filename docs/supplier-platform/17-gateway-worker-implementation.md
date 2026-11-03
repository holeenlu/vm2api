# Gateway Worker 技术实施、迁移与验收

更新于 2026-11-02。本页保留原实施工作包作为设计依据；当前可执行实现已收敛到 Node/Go `codex-gateway` 分支，具体文件、已验证能力和剩余验收见 `18-gateway-worker-node-go-implementation.md`。

## 1. 实施原则

1. 先冻结协议和状态，再写迁移和 UI。
2. vm2api 是唯一业务控制面；NewAPI Worker 只做指定账号的转发。
3. 账号 execution_kind 是长期业务事实；Fleet/Server 是短期运行事实。
4. 账号并发和 Server 并发分开租约；Server 故障不能误停账号。
5. Receipt、usage、客户扣费和供应商结算全部由 vm2api 幂等。
6. 现有 VM 路径继续通过 VM/slot 运行时；Worker 不创建 VM 文件、容器或 KVM guest。
7. 每阶段保留回滚边界，不用整文件覆盖或隐藏旧入口模拟完成。

## 2. 目标代码边界

vm2api 建议新增：

    src/lib/gateway-worker/
      fleet-repo.mjs
      server-repo.mjs
      dispatch-repo.mjs
      receipt-repo.mjs
      worker-client.mjs
      worker-capabilities.mjs
      worker-scheduler.mjs
    src/lib/vendor/vendor-execution-policy.mjs
    src/lib/vendor/vendor-account-execution.mjs
    src/lib/db/migrations/
    web/src/features/gateway-worker/
    web/src/features/vendor/account-execution/

NewAPI 建议新增：

    cmd/gateway-worker/
    internal/gatewayworker/
      register
      heartbeat
      dispatch
      cancel
      receipt
      drain
      health
    internal/providers/
    internal/transport/

禁止把 Worker 逻辑直接放入完整 NewAPI server、内部 UsageWorker、vm2api VM provisioner 或供应商 UI 组件中。

## 3. 数据迁移

### 3.1 账号

在现有 accounts/账号资源模型上追加：

    execution_kind
    vendor_resource_id
    credential_revision
    health_state
    availability_reason

gateway_worker 账号的 vm_id 允许为空。不能把 fleet_id、worker_server_id 或 dispatch_id 写入 vm_id。

如果 account_runtime.vm_id 当前非空约束阻碍升级，采用 table-copy migration：

1. 创建新 runtime 表，vm_id nullable；
2. 复制旧 VM 行；
3. 新增 execution_kind、config_revision、credential_revision；
4. 校验旧 VM 数量、账号组、状态和调度结果；
5. 原子替换表；
6. 保留回滚备份和迁移日志。

### 3.2 Worker 执行面表

至少新增：

    gateway_worker_fleets
    gateway_worker_servers
    gateway_worker_server_capabilities
    gateway_worker_server_runtime
    gateway_worker_dispatch_leases
    gateway_worker_receipts
    gateway_worker_sessions

Server、Lease、Receipt 的字段与 15 号文档一致。Server/Fleet 表不包含供应商 owner；账号 owner 只在账号资源和用量事实中保存。

### 3.3 请求和账务

request_attempts、usage_logs、vendor_usage_facts 追加：

    execution_kind
    account_resource_id
    vm_id nullable
    worker_server_id nullable
    dispatch_id nullable
    attempt_id
    send_state
    usage_confidence

历史 VM 行只补 execution_kind=vm 的可验证投影；不为旧历史伪造 Worker Server、Receipt 或 usage。

## 4. Worker Protocol v1

### 4.1 注册

Worker 启动后提交 enrollment、版本、boot ID、区域、协议和 capability。控制面返回 server_id、fleet_id、短时运行 token、heartbeat interval 和允许的协议版本。

注册失败原因：enrollment_invalid、version_unsupported、capability_invalid、fleet_disabled。

### 4.2 心跳

Heartbeat 只上报：

    server_id
    boot_id
    version
    capabilities_revision
    active_concurrency
    queue_depth
    drain_state
    receipt_backlog
    heartbeat_at

Heartbeat 不返回账号凭据，也不能通过 token 拉取完整账号池。

### 4.3 Dispatch

控制面发送：

    dispatch_id
    request_id
    attempt_id
    account_id
    platform
    credential_revision
    credential_snapshot/envelope
    proxy_snapshot/envelope
    protocol
    model
    body/stream reference
    expires_at
    nonce

Worker 只执行该 account/attempt，不自行换账号、不自行重试到另一个账号。发送前校验 lease、nonce、版本、capability 和 Server 状态。

### 4.4 Cancel

Cancel 先写控制面 cancel_requested，再调用 Worker cancel。Worker 返回 accepted、already_finished 或 not_found；控制面保留最终 attempt 事实。

### 4.5 Receipt

Receipt 至少包含：

    receipt_id
    dispatch_id
    request_id
    attempt_id
    account_id
    server_id
    send_state
    upstream_status
    error_code
    usage_confidence
    input/output/cache tokens
    upstream_model
    response_model
    started_at
    first_byte_at
    finished_at

receipt_id + dispatch_id 唯一。重复回执返回 duplicate，不重复写 usage、billing 或 vendor fact。乱序回执按照状态机拒绝冲突，允许迟到 usage 作为补充事实。

## 5. 控制面调度

    API Key / user / group admission
      → platform/model route
      → account candidate
      → account concurrency lease
      → VM slot 或 healthy Worker Server
      → Server concurrency lease
      → Dispatch Lease
      → forward
      → Receipt
      → usage / billing
      → release

账号候选必须通过供应商状态、父级范围、分组、平台、模型、凭据、额度、RPM、窗口和错误保护。Server 候选必须通过 Fleet 状态、能力、区域、版本、Drain、heartbeat 和实时容量。

发送前 Server 故障可以换同一账号的其他 Server。发送不明进入 ambiguous，不自动重放到其他账号或 Server。

## 6. 供应商和 Key 接线

新增 vendor execution policy 服务：

    GET /api/admin/vendors/:id/execution-policies
    PATCH /api/admin/vendors/:id/execution-policies
    GET /api/vendor/me/execution-policies

账号创建/编辑统一读取：

    vendor scope
      → platform policy
      → execution_kind
      → group policy
      → account capability

分组 resource_kind 增加 gateway_worker_account。分组不授权 Fleet/Server。API Key schema 不新增 execution_kind 或 server_id；调度从 Key 的 group_id 和模型解析。

## 7. UI 接线

按 16 号文档实现：

1. 资源管理新增 Gateway Worker 菜单；
2. Worker Fleet/Server 列表和详情抽屉；
3. 超管供应商策略卡片；
4. AccountWorkbench 执行方式列、创建分支和详情摘要；
5. 供应商门户隐藏 Server/Fleet/Dispatch；
6. Key 页面维持只选分组；
7. 使用记录增加 execution_kind、attempt、usage confidence 安全投影；
8. 四语、loading/empty/error/pending/unknown 状态齐全。

前端不直接把隐藏字段提交给后端；后端始终重读身份、策略、分组、账号和 Server 事实。

## 8. 分阶段工作包

| 阶段 | 内容 | 必测退出条件 |
| --- | --- | --- |
| P0 | 协议 schema、错误码、状态机、来源 SHA、许可证 | 控制面/Worker 互操作 fixture |
| P1 | execution_kind、策略、可空 VM、Worker 表、索引 | 新 Worker 账号无 VM；旧 VM 全部可读可调度 |
| P2 | NewAPI composition root、register/heartbeat/health | 一个 Server 多账号、不串凭据 |
| P3 | dispatch/cancel、账号/Server 双租约 | 同账号跨 Server；Drain 不接新任务 |
| P4 | Receipt inbox、usage、客户扣费、供应商事实 | 重复/迟到/unknown/partial 幂等 |
| P5 | UI/RBAC、策略、账号、分组、Key 和使用记录 | VM/Worker 页面和权限一致 |
| P6 | Fleet 集群、滚动升级、离线摘除、恢复注册 | Server 故障不误停账号 |
| P7 | Linux、代理、协议、备份恢复、性能 | 20 项最终验收通过 |

## 9. 测试矩阵

### 单元

- execution_kind 和 VM/Worker 绑定互斥；
- 策略 allow_create/allow_runtime；
- 分组 resource_kind 和平台能力；
- account/server 双租约；
- lease TTL、nonce、credential revision；
- Dispatch 状态单向推进；
- Receipt 重复、乱序、冲突、迟到；
- usage complete/partial/unknown/explicit zero；
- 供应商和用户投影脱敏。

### HTTP/SQLite

- Worker 草稿不创建 VM；
- VM 草稿和授权回归；
- 账号暂停、恢复、归档、父级撤权；
- Worker 注册、心跳、Drain、Resume；
- 同一账号跨两个 Server；
- 一个 Server 多账号；
- 同一 Key Claude VM + Codex Worker；
- 重复 Receipt 不重复扣费；
- 价格版本和账单快照不变；
- 403/401/策略撤销即时生效。

### 协议/浏览器/Linux

- JSON、SSE、取消、deadline、429、401、5xx；
- 上游发送不明和 response committed；
- Worker 重启、Receipt spool 重传；
- 代理出口和凭据刷新；
- 浏览器四语、响应式、表单字段裁剪、Fleet Drain；
- Linux 多 Server、滚动升级、备份恢复；
- 性能基准记录账号数、Server 数、并发、协议和上游延迟，不以静态推断替代。

## 10. 迁移、发布和回滚

- 新迁移只追加，不修改已应用历史迁移；部署前备份 SQLite 和 Worker 配置。
- 控制面和 Worker 分开发布；Receipt schema 至少兼容一个版本窗口。
- 新功能先以 capability/feature flag 关闭；开启前完成 fake Worker、HTTP 和账务回归。
- 下线 Worker 先关闭新 Dispatch，再 Drain Server，确认 pending receipt 为空或已进入人工对账。
- 版本回滚先 Drain 新版本，再注册兼容旧版本；不允许旧 Worker 读取不兼容的新字段。
- unknown/ambiguous 进入待核对队列，不自动退款、不自动补扣、不自动重放。

## 11. 完成定义

只有同时具备以下证据，才能把规划状态改为已实现：

1. 迁移在新库和现有库副本升级通过；
2. NewAPI 独立 Worker binary、协议 fixture 和来源/许可证记录齐全；
3. 一台 Server 多账号、一个账号跨 Server；
4. 同 Key 的 Claude VM + Codex Worker 分流；
5. duplicate/late/partial/unknown Receipt 账务回归；
6. UI/RBAC 和四语浏览器验收；
7. Linux 多 Server、Drain、恢复和备份演练；
8. 现有 VM 创建、授权、调度、用量和结算回归；
9. 发布、回滚和运维手册可执行；
10. 未授权接口、凭据泄露、Server pin 和重复收费测试均通过。

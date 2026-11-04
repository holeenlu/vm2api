# Gateway Worker 产品需求与最终决策

更新日期：2026-11-01（Asia/Shanghai）。状态：规划定稿，尚未实现、迁移或部署。本文与 [UI 与业务交互](16-gateway-worker-ui-workflows.md)、[技术实施与验收](17-gateway-worker-implementation.md) 构成唯一有效的 Gateway Worker 规划；旧版“账号绑定 Worker Pool、分组授权 Pool、供应商选择 Server”的方案已被替代。

## 1. 来源、现状与目标

本次按本地源码复核，未为文档任务同步上游或修改 NewAPI：

| 来源 | 复核快照 | 事实与边界 |
| --- | --- | --- |
| vm2api/main | `24dceec6e014c87708a20fe1b5579293cb1c5775`；父提交 `eec6301cad8a6fcd3a077cb723fb997ade3b5333`，VERSION 1.4.030 | Node/React/SQLite，已有 VM、API endpoint、供应商、Key、分组和账务；尚无本文 Worker |
| sub2api/NewAPI | `5804f679927b4101eccac18d96d0ca4dc15a626d` | 独立业务网关，一进程处理多账号；尚无本文独立 Worker root 和协议 |
| 历史供应商资料 | 01–14 号文档与交付记录 | 保留历史版本和测试事实；VM 专属描述不能推广到 Worker |

目标：所有角色继续只使用 vm2api 的页面/API；定制 NewAPI 提供指定账号的协议执行与事实回传。账号选择、业务权限、客户计费和供应商结算都留在 vm2api。现有 VM 内 `kin-worker`、KVM guest、API kernel 与新 Gateway Worker 分开；新 Worker 不自动获得 VM 的 guest、CLI、透明出口或硬件隔离特征。

## 2. 已确定的产品规则

1. 账号使用 `execution_kind=vm|gateway_worker`。执行方式与平台独立，Claude/Codex 可按已实现能力分别配置。
2. 一台服务器通常部署一个 Worker 进程承载多个账号；多个 Server 组成 Fleet。没有“一账号一 Worker”的关系。
3. 账号不得保存 `worker_id/worker_pool_id/worker_server_id/fleet_id` 作为永久绑定。每次实际 Server 只记入 Dispatch、attempt 和运维事实。
4. 创建账号时选择被策略允许的执行方式；只有一种则自动选中并只读显示，没有则禁止创建/授权。
5. Key 绑定一个商业分组。**同 Key 使用 Claude VM 与 Codex Worker，必须在其同一个分组授权两类账号及模型**；用户获得两个分组不等于一把 Key 能跨组。
6. 供应商可只开放 VM、只开放 Worker，或按平台分别开放；Claude=VM、Codex=Worker 是配置示例，不是强制默认。
7. vm2api 唯一选账号、分配容量和重试预算；Worker 不重新选号、不独立计费、不保存客户 Key 或完整账号池。
8. 供应商保留现有编辑白名单：名称、备注、分组、自有代理和授权。并发、RPM、权重等仍归超管；execution_kind 只在创建时选择。
9. Fleet/Server 是平台运维容量，不是供应商商品、价格维度或供应商所有物。
10. 首期采用一个有写入权的 vm2api 控制面调度多个 Server；不把 Worker 集群化等同于控制面 active-active 已实现。

## 3. NewAPI 复核与移植边界

| 源码（相对 sub2api/backend） | 已观察行为 | 决定 |
| --- | --- | --- |
| `ent/schema/account.go`、`account_group.go` | 账号含平台、凭据、代理、concurrency、priority、状态/窗口；账号与分组多对多，无外部 Worker 绑定 | 复用账号语义，不让账号承载服务器容量 |
| `internal/service/gateway_scheduling.go` | 模型路由、粘性候选、平台/模型/状态/额度/RPM/窗口过滤、负载排序和账号槽位 | vm2api 选择性适配；不保留第二个完整选号器 |
| `internal/service/concurrency_service.go` | AcquireAccountSlot 按账号获取和释放容量 | 账号并发跨 Server 共享，不能每台各发一份上限 |
| `internal/host/usage_worker.go` | 内部恢复/定时任务队列和结算执行/排空 | 不是外部 Worker，不以改名复用 |
| `cmd/server/wire_gen.go`、`internal/server/routes/gateway.go` | 完整 server 依赖业务库、缓存、账号、用户、分组、鉴权和计费 | 新建 `cmd/gateway-worker`；不使用 simple mode 或假 User/Group |
| `internal/providers/openai/http.go` | 单次传输与发送证据，不含全部协议转换/usage/刷新 | 提取 transport，service 逻辑须拆除业务仓库依赖 |
| `internal/gateway/model/operation.go` | UsageFact、AttemptFact、DeliveryReceipt | 保留缺省/显式零、累计/增量、上游事实/客户端交付区分 |

这些是静态复核，不是性能、真实授权和集群验收。现有 Claude schedule_level、Codex weight/smart、会话 preferred 和 group_resources.priority 的方向及作用域保持，不粗暴替换为一个优先级。

## 4. 对象与职责

| 对象 | 权威方 | 不变量 |
| --- | --- | --- |
| 账号资源 | vm2api | 稳定 account_resource_id、owner、平台、执行方式、配置/凭据版本 |
| VM 绑定 | vm2api | 仅 VM 账号持有，沿用预配、启动、出口和归档 |
| Fleet（集群） | vm2api 运维 | 区域、能力、版本准入；不是账号字段 |
| Server | 注册表/执行面 | server ID + boot ID；进程共享多账号 |
| Dispatch Lease | vm2api | 一次 attempt 的账号、Server、版本、期限和 nonce |
| Receipt | Worker 观察，控制面持久接收 | 发送、usage、错误、终态；不证明最终客户端收到输出 |
| Client delivery | vm2api | 最终客户端 headers、业务字节、flush、断开 |
| Charge/Vendor fact | vm2api | 客户请求最多一次扣费，实际执行账号归属不可覆盖 |

“Worker Pool”只作为旧方案术语说明；目标 UI 使用“Gateway Worker / 集群 / 服务器”，不保留 Pool 与 Fleet 两套对象或接口。

## 5. 供应商执行策略

规范化策略键为 `(vendor_id, platform, execution_kind)`，值为 `allow_create/allow_runtime/revision/updated_at/updated_by`。系统能力、供应商及父级平台/分组/执行策略取交集；子级不能用空值、0 上限或继承扩大父级权限。

| 变更 | 行为 |
| --- | --- |
| 关闭 allow_create | 立即拒绝新草稿和授权完成提交；存量账号仍可维护/重新授权/运行，受其他权限约束 |
| 关闭 allow_runtime | **立即禁止新 Dispatch，再排空在途请求**；不等待排空后才关闭准入；账号业务状态不改，另显示 policy_blocked |
| 再次开放 runtime | 只解除本策略阻断，不清除人工暂停、凭据异常、真实限流或归档 |
| 创建开放、运行关闭 | 可创建并授权，显示“策略停用，暂不接流量” |
| 停用父供应商 | 子级新建和新请求失去资格；历史事实/账单/owner 保留 |

只有 super_admin 配置执行策略；一级创建下级沿父级有效策略继承，不新增供应商给自己提权的入口。策略修改用 expected_revision，草稿提交、重新授权、分组绑定、排队授予和 Dispatch 前重读。

迁移默认：现有 vendor.vm.create 映射为 VM allow_create；VM runtime 保持现有供给资格，不能用创建权限禁止存量运行；Worker 创建/运行默认关闭，由超管显式开启。迁移后门禁统一为 vendor.resource.manage + 执行策略，清理 vendor.vm.create 的运行依赖；历史能力值仅用于迁移/审计。**不新增 vendor.account.create 重复门禁。**

## 6. 账号新增、编辑和生命周期

具体页面参数见 [16 号文档](16-gateway-worker-ui-workflows.md)。

### 6.1 创建

超管先选供应商，门户固定当前主体。两端共用同一领域流程：

    身份/父级/策略 → 平台 → 执行方式 → 认证 → 自有代理 → 授权分组
      → 30 分钟短期草稿（不生成账号行/VM）
      → OAuth 或导入验证 → 提交前重读权限/限额/版本/幂等
      → VM：账号 + 配对 VM + 凭据 + 代理/分组 → 启动
      → Worker：账号 + 凭据 + 代理/分组 → 能力/连接探测
      → 返回已保存资源与真实 availability

授权失败、取消、草稿过期不占账号额度。提交后启动/探测失败返回已有账号和安全原因，避免重复新建。换票与数据库非同一事务，须保存授权结果待提交状态并支持幂等恢复，刷新代际不能回退。

已验证提交的 Worker 账号无可用 Server 时保留 active，availability=executor_unavailable，不伪造凭据错误；尚未验证的草稿保留可重试状态，不能显示账号已创建。

VM 自动命名沿用 vm-NN；Worker 独立使用 gw-account-NN 展示名，稳定 ID 不由名称决定，不创建 VM 文件。旧名称不改写。

### 6.2 编辑

- owner、平台、execution_kind 只读；供应商只能修改当前白名单。
- config_revision、credential_revision 与分组资源版本独立 CAS；普通编辑不能覆盖后台凭据刷新。
- 修改分组影响下一次准入；已撤销组只可移除，不可重新选择。
- 修改代理校验归属、协议、健康和限额；新请求使用新快照，在途使用旧快照，旧连接池按代际排空。Worker 不调用 Docker/VM 出口重建。
- Worker 无全 Fleet 账号 apply 流程。“生效”表示后续 Dispatch 携带新版本，不要求所有 Server ACK。
- 空凭据输入表示不变，脱敏占位不能覆盖真实值。更换上游身份时清除旧身份亲和/配额投影，历史事实保持。

### 6.3 状态、归档和迁移

持久资源状态保留 provisioning/active/paused/archived；授权草稿、health、availability 独立，不把 ready/error 写成 vendor_resources 新枚举。Server offline 不改变账号商业状态。

暂停立即挡新请求，默认已发送请求排空；恢复只解除本次暂停。归档先挡新请求并处理在途/刷新租约，再释放代理引用；Worker 归档不停止 Server 或其他账号，VM 继续原运行时清理；历史用量、owner 和账单保留。

VM↔Worker 不支持普通 PATCH 切换。受控迁移先阻止旧账号新流量，新执行记录重新授权/验证，切分组后归档旧记录。相同凭据重复导入默认拒绝第二个 active 记录，避免克隆额度；迁移并行探测不授予第二份生产容量。

## 7. 分组、模型和 API Key

当前 group_resources.resource_kind 仅允许 vm/api_endpoint，relay-routes 拒绝混合后端；目标增加 gateway_worker_account，resource_id 指稳定账号业务资源，不指 Server/Fleet。

按平台配置 allowed_execution_kinds：

| 示例组 | Anthropic | OpenAI | 行为 |
| --- | --- | --- | --- |
| 综合 Coding | vm | gateway_worker | 一把 Key 调 Claude 进 VM，调 Codex 进 Worker |
| Claude VM | vm | 不开放 | 只访问该组 Claude 模型 |
| Codex Worker | 不开放 | gateway_worker | 只走该组 Worker |
| 同平台双方式 | vm + gateway_worker | 按配置 | 同模型/协议/会话兼容验收后才开放；流中不能切换 |

跨平台混用必须随最终交付实现，不能保留“每组一种后端”却声称同 Key 支持两类。API endpoint 商品和调度保留独立，首期不开放与账号后端混组。

目录、分组编辑、供应商可选组、Key scope 和调度共用 capability 交集。无组、空组、停用组、无适配模型不回退全局/其他组。容量按账号及 Server 去重，不把所有绑定组容量相加当真实可用量。

客户端仍用 vm2api Base URL、Key 和现有 Messages/Responses/Chat 等接口；模型/协议选择平台与候选，不增加客户端 Server pin 或“VM/Worker”请求头。

    同一个 Key → 同一个综合组
                    ├─ Claude → VM 候选 → 原 VM 路径
                    └─ Codex → Worker 账号 → 健康 Server
                                     ↓
                       vm2api 使用记录、价格和账务

Key 仍保留现有用户、限额、有效期、IP、平台/模型限制。“只绑定分组”仅指供给授权，不删除其他字段。授权模型目录不随短暂 Server 离线抖动；暂时无容量返回安全忙碌/不可用错误，不能假装模型执行成功。

## 8. 调度、集群和隔离

Worker 路径先账号后 Server；VM 仍复用原 slot scheduler，不为 Worker 重写选槽逻辑。各层用户/Key/组并发和 RPM、账号并发/额度、Server 容量独立准入；不能把含 0=不限的数值直接取 min。账号跨组/Server 共用一次额度。

无 Server 容量时有界排队；未派发的账号租约释放后重试，不长期占着账号等 Server。Server 租约校验 boot ID、expiry、nonce 和版本。Server 故障只影响执行容量；上游认证/配额影响账号，代理错误影响代理，RPC/磁盘/版本错误影响 Server，不批量停用账号。

支持同机私有 Unix socket、跨机 mTLS；多 Server 共用一个控制面。Worker 不挂载 SQLite，不引入完整 NewAPI PostgreSQL/Redis。多控制面 active-active 需先实现共享原子租约、选主 fencing 和幂等账务，另行验收。

## 9. 使用记录、用量与结算

Worker 只报原始数量和证据质量，不能计算价格。unknown、explicit zero、partial、完整终态分开；缓存读写/TTL、reasoning 包含关系、图片等单位避免重计。未知显示“—”，部分已知显示“≥ 已知值”。

持久记录 request 的客户端交付、attempt 的实际账号/Server/发送、Receipt 的序号/哈希/完整性。供应商归属来自 account_resource_id 与执行时 owner 快照，不能从当前 Server 或被修改的 owner 反推。

- 客户 charge 仍按服务端 request/billing root 幂等，一次请求最多扣一次。
- 重复/迟到 Receipt 可补技术事实；已有完成账单不按新价格重算。技术 ACK 不代表再次扣费授权。
- 保留“无实际费用不预扣、不恢复资金预留、不自动补扣未知费用”。首次最终提交前可靠重试可幂等完成；已结束为未知未计费的请求，迟到事实不自动扣款。
- VM/Worker 共用现有全局 OpenAI/Claude 采购单价、汇率与生效版本；新平台缺价格规则则阻止结算，不猜价。
- 多 attempt 分别保留原始观察，只有符合当前协议可结算条件的事实进入财务链；失败 attempt 不自动生成第二笔扣费/应付款。
- 部分图片成功后失败须按该协议契约验收，不能用最终状态抹除事实。
- 日志 off 仍保留计量摘要、Receipt 与财务幂等事实；日志裁剪不丢账单来源。
- 业务时间固定 UTC+8，今天截至查询时刻，历史时刻与已出具账单不改写。

## 10. 权限、菜单与发布边界

super_admin 管 Worker 运维/执行策略/账号限制；admin 按现有管理域管用户与消费，user 管本人 Key/用量，vendor 管自有账号/代理/分组关联/用量。没有新增 ops 登录角色；gateway_workers view 与运维 capability 首期只授予 super_admin。

供应商不展示 Server ID、Fleet、总队列、其他账号、Dispatch、凭据版本；只展示执行方式和安全可用性原因。终端用户不新增后端选择或内部执行详情。

资源管理新增 Gateway Worker 菜单，位于“虚拟机”后；其他布局和菜单顺序不变。完整规范见 [16 号文档](16-gateway-worker-ui-workflows.md)。

本轮无新增真实接口、配置、迁移、业务实现或部署；规划字段与端点均待实现。NewAPI 移植/发布须遵守其仓库规则，vm2api 交付授权不自动成为跨项目发布或生产部署授权。

## 11. 阶段与完成定义

| 阶段 | 交付 | 退出条件 |
| --- | --- | --- |
| P0 契约 | schema、版本、错误、幂等、能力矩阵、来源 SHA | 无账号绑定 Pool、重复账务、越权字段 |
| P1 数据/权限 | execution_kind、策略、无 VM 账号、组资源、执行事实 | 新/旧库与 VM、历史账务回归 |
| P2 Worker | 独立 root、单次执行、帧流、Receipt spool、刷新端口 | 一进程多账号不串凭据，无完整业务库依赖 |
| P3 调度/Key | 双层租约、跨平台综合组、能力路由 | 同 Key Claude VM + Codex Worker，撤权即时生效 |
| P4 用量/账务 | Receipt inbox、价格快照、记录/统计/供应商关联 | 重复/迟到/未知/部分/取消/断线不重复记账 |
| P5 UI/RBAC | 账号、策略、分组、日志/统计、运维 | 两端一致、权限裁剪，旧入口无遗留 |
| P6 集群 | 多 Server、Drain、版本准入、故障恢复 | 故障不误停账号；不承诺流中无损迁移 |
| P7 验收 | 自动化、浏览器、Linux、来源/许可/资产摘要 | 必需用例通过后才开放对应能力 |

首个业务闭环优先 Claude 保持 VM、Codex OAuth/账号文件走 Worker；OAuth 刷新/CAS、Responses HTTP/SSE 和同 Key 分流属于首期。可以先用 API-Key transport 做内部验证，但不能当作 Codex OAuth 已完成。

Worker Claude、Gemini、WS、Images、BPS/Cloud、音视频和异步任务按能力逐项验收开放。单机容量不得按账号数推定；性能方法和完整验收见 [17 号文档](17-gateway-worker-implementation.md)。

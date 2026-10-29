# TapModels 定制实现总记录

更新日期：2026-10-29

本文是 tapmodels/vm2api 定制代码的统一需求、规划、实现和验收记录。它与 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 配合使用：本文件按功能说明“为什么做、怎么规划、改了什么、如何验证”，Release Note 记录版本交付、升级、清理和限制。两份文档随同唯一的定制提交交付。

## 交付基线与历史形态

本轮普通需求沿用已交付 main 的唯一上游父提交 `bc9d1873a9a08f6e9a8f8fac9e4937e85bb1e117`（v1.4.025），未主动同步新上游；最终交付保持：

```text
bc9d1873a9a08f6e9a8f8fac9e4937e85bb1e117
└── tapmodels 定制提交
```

最终 main 只保留一个定制提交。此前按功能产生的定制提交、同步候选和临时合并树均不进入正式历史，完整恢复材料保存在仓库外 bundle 中。


### 本轮供应商账号与代理池增量（2026-10-29）

#### 需求决定

- 供应商创建账号就是创建 VM；表单只让供应商输入名称、授权方式、代理和分组。
- 平台类型由授权方式推导，VM 的运行环境、内核、语言、区域和机器规格采用系统默认值。
- 创建后直接进入对应授权操作，VM 绑定所选代理和分组，并自动尝试开机。
- 供应商代理只能被同一供应商的账号使用；运营后台代理池可以查看全量并按供应商、平台筛选。

#### 实现内容

- `web/src/features/vendor/index.tsx` 删除账号创建表单中的平台、环境、区域和语言输入，统一覆盖 Claude OAuth/Setup Token/Console 与 Codex OAuth/账号文件；创建成功后复用 `CredentialPanel` 展示对应授权流程。
- `src/lib/vendor/vendor-vm-provisioner.mjs` 从 `routing.vm` 读取系统默认运行时和机器规格，供应商请求不能覆盖 VM 参数。
- `src/lib/admin/panel-routes.mjs` 在供应商账号创建流程中同步供应商代理到统一 `ProxyPool`、绑定运行时 VM、分配分组并调用 `startSlotReady`；供应商授权接口仅允许访问自己账号关联的运行时 VM。
- `src/lib/admin/panel-acl.mjs` 放行供应商所需的分组读取、VM 启动、shell ticket、OAuth 授权和凭据导入接口；`src/lib/admin/relay-routes.mjs` 为供应商返回分组目录投影。
- `065_vendor_proxy_pool_metadata.sql`、`src/lib/db/repos/proxies-repo.mjs` 和 `src/lib/vm/proxy-pool.mjs` 增加代理供应商归属、供应商资源映射和适用平台元数据；供应商代理仍由统一池负责持久化、探测和绑定。
- `web/src/features/proxies/index.tsx`、`queries.ts` 和面板类型增加超级管理员的供应商/平台筛选；平台从代理元数据和已绑定 VM 类型合并得到。

#### 清理与兼容

- 删除供应商运行环境、语言、区域输入、校验与写入路径；服务端 VM 配置只取系统默认，不读取这些客户端字段。
- 保留供应商业务资源表作为归属和脱敏事实，新增统一池映射字段；不删除既有代理、VM、分组或审计数据。
- 既有平台代理没有供应商归属，继续属于平台；供应商不能借用其他供应商代理。供应商代理的统一池记录由供应商资源 ID 做幂等映射。

#### 验收

- `test/e2e/vendor-platform.e2e.test.mjs` 覆盖供应商代理加入统一池、账号与 VM 配对、代理绑定、平台运营查询和自动启动返回值。
- `test/unit/vendor-platform.test.mjs`、`test/unit/vendor-portal-view.test.mjs`、`test/unit/proxy-pool-bind.test.mjs` 和 `test/unit/proxy-pool-import.test.mjs` 与本轮新增回归共同纳入 164 项通过记录。
- `web/tsconfig` TypeScript 检查通过，四语供应商和代理 JSON 可解析，`git diff --check` 通过。自动启动的隔离测试环境没有宿主 `iptables/kin-egress`，因此只验证失败状态可见且 VM 不被错误标记为 running。
- 远端已完成的 native telemetry/账务修复保留，删除草稿重复兼容代码；macOS seed 本地路径回退禁止符号链接目录。前端 TypeScript 与 Vite 构建通过。

### 本轮 7D 预计总量与持久化刷新（2026-10-29）

- 来源：本机 sub2api 干净的相关文件，HEAD `0276190e775b369319acc18bc1c120a4469a71ae`。算法参考 `frontend/src/components/account/AccountUsageCell.vue:estimatedWindowCost`；重置窗口边界参考 `backend/internal/service/claude_reset_credits.go:persistClearedUsage`；查询落盘参考 `backend/internal/handler/admin/openai_oauth_handler.go:RefreshQuota`。
- 采用：同一窗口的金额/Token 除以额度比例；实时估算不受 5% 或完整日志覆盖门槛影响。保留：本项目对未定价请求、已到期窗口的保护，独立的累计账务及历史窗口余量算法。
- 后端：`window-estimate.mjs` 计算；`claude-reset-credits.mjs` 查询/兑换后读取并同步持久化用量；`AccountQuota.clearUsageWindows` 保存明确被上游清零的窗口及时间；`usage-logs-repo.mjs` 把此时间纳入费用边界和缓存键，重置前费用不进入新窗口。
- 前端：`vm-usage.ts` 的总计只使用 estimate_7d，无值显示未知；`usage-windows` 与机架显示同口径，并保持估算标记。额度操作返回前完成持久化，已有 Query invalidation 同时刷新四类视图；读取失败显示明确提示。
- 权限补齐：统一代理池的 bind/allocate/getProxyForVm 均验证供应商归属；强制绑定、平台代理自动分配和备用出口切换不能跨供应商。供应商分组目录与提交采用同一授权范围，不以无匹配分组为由回退全部分组。
- 验收：后端和 E2E 164/164，前端 51/51、TypeScript、Vite 构建通过。覆盖比例 69% 的截图数值、低于 5%、零/未知/非有限输入、SQLite 立即重读、重置后读失败、幂等重放与新窗口费用。
- 无真实重置券/推理操作、无生产部署或数据清除。自动开机测试使用隔离环境，当前宿主缺少 Linux iptables/kin-egress，仅验证启动失败可见；真实 VM 开机仍需部署后在目标 Linux 环境验收。

### CI 收口（2026-10-29）

首次交付后 CI 暴露已有前端格式、旧管理员权限断言、ARM64 缺失 native-cli 构建阶段与旧源哈希。按实际现行权限更新 E2E，补回上游构建阶段并下载/校验当前锁定 payload 后重算源码哈希；不改变供应商/运营权限实现、不关闭 CI。前端全量格式、HTTP/native CLI 15 项与 Python 7 项通过。受影响文件为 9 个前端格式文件、panel-users E2E、deploy/Dockerfile.arm64-control 与 deploy/arm64-cli.json；不触及生产运行数据。

## 角色、运营后台与导航

### 需求与规划

- `super_admin` 是超级管理员，负责平台策略、用户/管理员、VM、供应商和系统资源。
- `admin` 是管理员，只管理普通用户 `user`，查看用户使用记录和数据；不能创建 VM、供应商或修改平台系统策略。
- `user` 管理个人 API Key、模型使用和个人用量。
- `vendor` 是供应商唯一登录角色；一级/二级供应商由供应商主体的 `tier`、`parent_id` 和 `root_id` 表达，不能把一级/二级拆成不同登录角色。
- SA 登录默认入口为 `/overview`，AD 为 `/users`，U 为 `/keys`，供应商进入 `/vendor`；工作台入口已按用户要求移除。
- 普通后台侧栏按“运营管理 / 资源管理 / 系统管理”组织，服务提供商信息归入运营管理。

### 实现内容

- 迁移旧角色编码：旧 `admin` 转为 `super_admin`，旧 `super` 转为 `admin`；有效供应商成员统一为 `vendor`。
- 统一用户新建表单角色选项，SA 可创建供应商并配置是否允许创建下级供应商。
- 供应商创建配置包括下级供应商能力、下级数量上限、账号/代理额度、平台和分组范围。
- 后端按角色和能力保护路由，前端菜单只作为能力投影，不能替代后端鉴权。
- 删除“工作台”入口及旧的供应商平台单页回落逻辑，保留欢迎页和既有个人/运营功能。
- 用户流程移除 GitHub 引导提示，保留品牌和登录行为。

### 主要代码与数据

- `src/lib/admin/panel-users.mjs`
- `src/lib/admin/panel-acl.mjs`
- `src/lib/admin/panel-routes.mjs`
- `web/src/features/users/index.tsx`
- `web/src/components/layout/data/sidebar-data.ts`
- `web/src/components/layout/app-sidebar.tsx`
- `src/lib/db/migrations/054_panel_role_names.sql`
- `src/lib/db/migrations/057_supplier_login_role.sql`

## VM、额度、用量与调度

### 需求与规划

- 受限 VM 必须显示 5 小时、7 天和冷却限制的解除倒计时及具体时间。
- 用量进度、额度和请求事实要持久化，刷新机制参考 sub2api 的窗口快照和用量日志分层。
- 7D“总计”优先表示根据当前 7 天窗口进度和金额反推的预计完整用量；数据不足时显示累计值或未知，不能伪造预计数字。
- 分组内 VM 优先级同时影响 GPT 和 Claude 调度链。
- 反向代理部署可以把控制面收回环回地址，默认行为保持不变。

### 实现内容

- VM 卡片和详情页显示解除时间、窗口进度、额度状态和调度原因。
- 沿用账号统一快照、分配窗口、用量日志和查询缓存失效机制；额度查询、重置和官方用量操作后立即刷新相关数据。
- 7D 预计用量只有在窗口、日志覆盖和定价条件满足时才计算，并用 `≈` 说明估算；否则回退累计账务或 `—`。
- 调度资格快照过期时重新计算准入，避免因为旧快照导致空等。
- `docker-compose.yml` 支持 `${HOST:-0.0.0.0}`，反代场景可设置 `HOST=127.0.0.1`。
- VM 离线通知和 C.UTF-8 等语言/环境文案补齐四语资源，保持通用 `C.UTF-8` 大小写。

### 主要代码与数据

- `web/src/features/vm/`
- `src/lib/admin/panel-api.mjs`
- `src/lib/admin/window-estimate.mjs`
- `src/lib/pool/`
- `src/lib/vm/`
- `src/lib/db/migrations/048_billing_subscription_windows.sql`
- `docker-compose.yml`
- `docs/DEPLOY.md`

## 供应商平台首版

### 需求与规划

- 供应商开户使用独立供应商平台流程；当前表单只提交名称、授权、代理和分组，平台与 VM 运行参数由授权方式和系统默认值推导。
- 供应商添加账号时，后台自动创建账号资源并配对 VM；供应商不能直接调用运营后台 VM 创建接口。
- 一级供应商只有在拥有 `vendor.create_child` 时才显示“供应商管理”，没有该能力时隐藏下级供应商入口。
- 下级供应商最多一层；下级平台、分组、账号额度和代理额度必须是父级允许范围的子集。
- 账号池、IP 代理和用量查询支持当前供应商、直属下级和全部可见范围；下级资源只读。

### 实现内容

- 新增供应商、成员、能力、资源、资源授权、合同、用量事实、结算、付款和审计数据模型。
- `/api/vendor/*` 为供应商接口，`/api/admin/vendors/*` 为超级管理员运营接口。
- `POST /api/vendor/accounts` 在事务内创建账号资源、配对 VM 资源和运行时 `vms/<id>.json`，支持幂等重试。
- `POST /api/vendor/vms` 固定拒绝直接创建并返回 `account_creation_required`。
- 供应商账号暂停同步 `schedule_off`，恢复只撤销供应商暂停，不清理无凭据、冷却和平台限制。
- 代理地址的认证信息加密保存，公开列表脱敏；资源 PATCH 限制为名称和状态，禁止客户端改写内部 VM 关系。
- 供应商平台前端按“资源 / 统计”组织，并使用 `/vendor/:page` 独立路由、能力感知菜单、筛选、分页、刷新、移动端导航和主题切换。

### 主要代码与数据

- `src/lib/vendor/vendor-platform.mjs`
- `src/lib/vendor/vendor-vm-provisioner.mjs`
- `src/lib/vendor/vendor-portal-view.mjs`
- `src/lib/admin/panel-routes.mjs`
- `web/src/features/vendor/index.tsx`
- `web/src/features/vendor/portal-model.ts`
- `web/src/routes/vendor/`
- `src/lib/db/migrations/056_supplier_platform.sql`
- `src/lib/db/migrations/057_supplier_login_role.sql`

## 供应商账号池、用量统计与统一账单

### 来源与规划

本轮对照定制 sub2api 的供应商实现和已登录的 `supplier.tapmodels.ai` 页面，重点比较账号池、用量统计、供应商结算档案、`/vendor/settlements` 和 `/vendor/payables`。采用的原则是：保留 vm2api 现有 SQLite、VM 和面板快照架构，把 sub2api 的数据语义移植到现有边界，不直接跨项目复制 Vue/Go 实现。

### 账号池

- 账号概览增加总数、可用、等待授权、暂停、RPM、TPM、实时并发、接近限额和累计消耗。
- 账号行投影增加 5 小时/7 天窗口、Token、缓存、请求、窗口金额、错误分类、调度和授权状态字段。
- 没有可用快照时显示未知；等待授权不计作可用；不把未知消耗填成零。
- 账号池继续支持平台、状态、供应商、名称/账号 ID 筛选，以及账号与配对 VM 的状态展示。

### 用量统计

- 新增 `/api/vendor/usage`，按周期、供应商范围、账号和模型返回请求数、输入/输出 Token、金额趋势和维度数据。
- 优先读取持久化 `vendor_usage_facts`；持久化事实为空时，按照账号与 VM 的运行快照回退展示，避免新开户后页面完全空白。
- 一级供应商可以查询自己、直属下级或全部可见范围；二级供应商不能查询父级、兄弟或下级。

### 结算档案与账单

- 新建供应商和新建下级供应商支持保存联系人、结算邮箱、币安 ID、默认采购单价、OpenAI/Claude 分组采购单价、结算汇率、结算倍率和合同版本。
- 新增 `062_vendor_billing_profile.sql`，把结算档案字段持久化到供应商主体，并创建对应合同默认值。
- `/api/vendor/billing` 统一返回上游账单、一级供应商向直属下游生成的账单和当前结算档案。
- 一级供应商可以 POST `/api/vendor/settlements` 按下游供应商和日期范围新增周期结算；二级供应商没有该写权限。
- 门户把原先的“上游应收”和“下游应付”合并为“账单”，一级显示上下游两类账单，二级只显示上游账单。
- 下游结算金额使用持久化用量事实、合同采购单价、结算倍率和结算汇率计算；没有事实时不凭空生成用量明细。

### 主要代码与数据

- `src/lib/vendor/vendor-portal-view.mjs`
- `src/lib/vendor/vendor-platform.mjs`
- `src/lib/admin/panel-routes.mjs`
- `web/src/features/vendor/index.tsx`
- `web/src/features/vendor/portal-model.ts`
- `web/src/features/users/index.tsx`
- `src/lib/db/migrations/062_vendor_billing_profile.sql`

## CPR P0 与运行事实

### 需求与规划

参考 CPR 研究资料，将运行配置快照、请求发送事实和账号级错误保护作为独立能力逐步落地；不整体迁移 CPR 的 PostgreSQL、Redis、S3 或插件 Runtime。

### 实现内容

- runtime config revision 和深冻结 routing snapshot，旧客户端缺失 revision 保持兼容。
- request attempt 增加 `not_sent / ambiguous / sent`，并在协议、worker、kernel、failover 链路传递发送事实。
- 账号错误保护使用 fingerprint、策略 revision 和 SQLite CAS，默认关闭并与 provider circuit 分离。
- 新增迁移 057–060、定向测试和 CPR 研究资料，保留本项目现有 SQLite 和 VM 拓扑。

### 主要代码与资料

- `src/lib/core/runtime-snapshot.mjs`
- `src/lib/pool/account-error-protection.mjs`
- `src/lib/admin/routing-runtime.mjs`
- `src/lib/transport/`
- `src/lib/db/migrations/057_runtime_config_revision.sql`
- `src/lib/db/migrations/058_request_attempt_send_state.sql`
- `src/lib/db/migrations/059_account_protection_runtime.sql`
- `src/lib/db/migrations/060_request_log_config_revision.sql`
- `docs/cpr/`

## 首页、品牌、多语言与发布流程

- `/welcome` 重构为 TapModels.ai 营销首页，包含 API 示例、模型/价格、请求链路、团队访问、Agent、控制台预览和 CTA。
- 首页主题跟随全站亮色、深色和系统主题，语言切换支持英文、简体中文、繁体中文和日文。
- 版本卡片、品牌副标题、欢迎页文案、系统提示词、C.UTF-8 和 VM 离线通知均按四语维护。
- 部署文档补充反代、环回监听、证书续期和未知 SNI 处理；发布工作流保留普通 CI，并区分同版本定制推送与上游版本发布。
- 应用、guest/KVM 镜像和生产部署均不因代码推送自动执行；只有上游版本递增时才进入既定自动发布条件。

## 清理、保留与未完成范围

### 已清理

- 工作台入口和旧供应商单页回落入口。
- 独立二级账号池、二级代理和“下级供给”菜单，统一为能力感知的“供应商管理”。
- 新用户流程中的 GitHub 引导提示。
- 旧角色显示名称和被替代的供应商菜单文案。

### 有依据保留

- 普通后台 SA 专用 VM 创建入口，因为它仍是平台管理职责。
- 供应商资源、用量、合同、结算和审计历史，因为这些数据仍有读取方。
- 既有 VM、SQLite、代理池、账号快照和面板用量实现，因为供应商门户需要与现有运行时共享事实来源。

### 尚未实现或未执行

- sub2api 全套 OAuth 授权向导、批量导入导出、代理质量检测和全站 RPM/TPM 汇总仍未完整移植。
- 账单目前支持档案、账单读取和一级向下游创建周期结算；支付登记、复杂调整、对账审批和完整财务流水仍需独立实现。
- 未执行生产数据库迁移、生产部署、真实供应商 OAuth、真实收费推理或付款操作。

## 验证记录

本轮供应商相关验证包括：

- Node 后端供应商、门户和迁移回归：32 项通过。
- 供应商 HTTP E2E：2 项通过，覆盖登录、账号/VM 配对、零上限、下级范围、结算档案、统一账单和下游结算接口。
- 前端供应商模型测试：通过。
- 前端 TypeScript、指定文件 Prettier、Vite/Docker 构建：通过。
- 本机 Docker `127.0.0.1:8787/health`：`ok`。

历史定制的更完整命令、上游同步记录和 CI 限制见 `docs/CUSTOMIZATION_RELEASE_NOTES.md`、`docs/CUSTOMIZATION_FILE_INDEX.md`、`docs/CHANGE_DELIVERY.md` 和 `docs/cpr/`。

## 前端界面国际化完整性修复（2026-10-29）

### 需求与问题范围

GitHub 的前端国际化完整性检查报告指出，当前定制版存在 189 处仍直接写入界面的文案。逐项审查后，问题集中在登录页的供应商入口提示、运营端服务提供商页、用户管理页的供应商/结算表单，以及近期新增的供应商门户。

### 实现内容

- 将登录页供应商平台提示、服务提供商页状态/额度/恢复时间、用户管理页供应商角色与结算字段迁移到现有翻译机制。
- 将供应商门户的导航分组、角色状态、权限提示、账号池、代理、供应商管理、用量统计、账单、审计、筛选、分页、弹窗表单、错误和空状态全部接入 `vendor` 命名空间。
- 新增并补齐 `auth`、`providers`、`users`、`vendor` 四个命名空间的英文、简体中文、繁体中文和日文资源；所有资源保持相同键集合，覆盖 `C.UTF-8` 的通用显示和结算单位文案。
- 统一使用翻译参数处理账号范围摘要、供应商名称、分页数量和窗口恢复时间，避免把运行时数据拼进固定文案造成语言切换不完整。

### 清理与边界

本轮不改变后端接口、权限判断、角色编码、数据库字段或结算计算。产品名、协议名、平台标识和资源运行时返回值仍按业务值展示；可翻译的界面标签、状态和提示均已纳入资源文件。

### 验证

- `web/src/i18n/coverage.test.ts`：5/5 通过，硬编码界面文案问题清单为空。
- `web/src/features/vendor/portal-model.test.ts`：2/2 通过。
- 前端 `tsc --noEmit`：通过。
- 相关源文件 Prettier：通过。
- 现有依赖直接执行 `vite build`：通过。
- `pnpm build` 未完成于依赖安装阶段，原因是当前 pnpm 拒绝执行 `esbuild` 构建脚本；该环境问题不影响已完成的类型、测试和直接 Vite 构建验证。

## Git 远端职责归整（2026-10-29）

为避免同步上游和交付定制仓库混用，统一采用标准 remote 命名：`upstream` 指向只读上游 `dofastted/vm2api`，`origin` 指向个人定制仓库 `holeenlu/vm2api`。本地 `main` 跟踪 `origin/main`，`vm2api_main` 跟踪 `upstream/main`。本次只调整 Git remote、分支跟踪和项目交付文档，不改变业务代码、接口、数据库或部署配置。

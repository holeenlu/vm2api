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
- 普通后台侧栏按“运营管理 / 资源管理 / 系统管理”组织，供应商账号归入“供应商平台 → 账号池”；旧服务提供商独立页面已删除。

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

- 供应商开户使用独立供应商平台流程；先选择 Anthropic/OpenAI，再填写可选名称、代理、分组及对应授权。平台固定 VM 类型；运行参数使用系统默认值。
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
- 代理地址的认证信息加密保存，公开列表脱敏；账号 PATCH 允许名称、备注、匹配分组、自有代理及并发冲突版本；并发/权重只读，内部 VM 关系不可写。
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
- 从 `usage_logs` 统计真实请求、成功/失败、Token、延迟、趋势与模型分布；日志裁剪后使用没有对应请求日志的 `vendor_usage_facts` 补充历史成功记录，避免重复和丢失历史消耗。金额只计成功请求官方价；未知价格为 null，不回退累计运行快照。
- 一级供应商可以查询自己、直属下级或全部可见范围；二级供应商不能查询父级、兄弟或下级。

### 结算档案与账单

- 新建供应商和新建下级供应商仅保留登录身份及币安 ID、默认采购单价、OpenAI/Claude 分组采购单价、结算汇率、结算倍率和合同版本。
- 新增 `062_vendor_billing_profile.sql`，把结算档案字段持久化到供应商主体，并创建对应合同默认值。
- `/api/vendor/billing` 统一返回上游账单、一级供应商向直属下游生成的账单和当前结算档案。
- 一级供应商可以 POST `/api/vendor/settlements` 选择下游、自然日账期/时区、汇率/来源与调整原因，先预览再按令牌生成草稿；二级供应商没有该写权限。
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


## 2026-10-30 供应商账号池完整操作、平台联动与结算重构

### 来源、范围与合并决定

语义参考定制 sub2api `0276190e775b369319acc18bc1c120a4469a71ae` 的 `frontend/src/features/vendor/components/AccountWorkbench.vue`、`AccountForm.vue`、`SettlementWorkbench.vue`、账号统计组件及 vendor settlement 服务；React/SQLite 实现使用本项目既有 VM、授权面板和调度边界。按用户截图逐项补齐详情、用量、编辑、更多操作，没有整目录复制 Vue/Go。

本轮开发初始 main 为 `2d80d7c2`。交付时整合独立 main `6a978833` 已完成的 1.4.028、供应商运营管理、权限刷新、请求事实持久化、平台采购价格和运行时策略。保留其完整功能；本轮不追赶新的上游，最终父提交沿用该 main 的 `8cb05ff261dd6d8a7e90479463b33bc6e1585730`。保留新增供应商付款授权：生成草稿需要 create_child + settlement.read，确认/付款登记/作废还需 settlement.pay。

### 本轮完成的需求

| 需求 | 实现与边界 |
| --- | --- |
| 账号池 | sub2api 结构的账号概览、三类配额分布、平台/供应商/状态/分组/授权/故障/日期筛选、排序、列显示、分页、选择和批量暂停/恢复、统计 CSV；无权限下游只读 |
| 账号详情 | 侧边抽屉展示代理/地区、所属供应商、授权方式、权重、请求/Token、创建时间、分组/备注、最近一分钟 RPM/TPM、今日/累计成功率、并发、调度状态、冷却、配额重置时间、模型限制；打开时抓取快照 |
| 用量详情 | 默认全部历史；今天/7天/30天/自定义自然日范围。请求成功/失败、官方消耗、I/O Token、缓存、平均延迟和首字时间；固定滚动 5H/7D/30D 独立于筛选；请求/Token/金额趋势及模型分布 |
| 请求数为零 | 不再取未同步的账号累计计数；详情、账号行、用量页统一从真实日志统计，历史事实只补没有详细日志的请求。无时间归属的累计快照不冒充周期用量 |
| 编辑 | 名称、备注、可用模型分组、代理地区、自动分配或统一代理输入框；并发与权重展示平台值且服务端拒绝供应商修改。校验 updated_at 与分组版本，实际绑定池和 VM，运行环境未应用时提示并保留维护保护 |
| 代理统一输入 | 一个可编辑 combobox，既能搜索/选择自己的现有代理，也能粘贴 URL 或 IP:port:username:password；粘贴新代理在创建账号事务内保存，重复地址复用，认证信息加密且列表脱敏 |
| 平台联动 | Anthropic/OpenAI 选择决定授权面板、分组能力和 VM 类型；mixed 分组也按其实际模型范围筛选，空模型列表遵循现有分组不限模型的含义；切平台清空旧分组。服务端拒绝跨平台授权及不匹配分组，VM 类型只从校验后的 platform 生成 |
| 新建账号 | 名称留空时与运营后台共用 `newVmNaming`，按现有 VM 与保留账号历史自动编号为 vm-NN；账号与配对 VM 名称一致，自定义名称原样使用。代理和分组，选平台后立即显示其授权操作；首次授权操作幂等创建账号/VM、绑定代理/分组并尝试开机，授权成功后恢复可调度；失败显示 runtime_boot 的真实结果 |
| 更多操作 | 重新登录复用现有 VM 授权；删除先禁调度并停止运行环境，再归档账号/配对 VM、释放代理绑定，历史日志/账单保留 |
| 清除冷却 | 只清除自己的临时冷却及可解除的模型冷却；凭据撤销/平台保护/停用和真实配额继续生效；不能修改直属下游或跨供应商共享账号状态 |
| 新建供应商 | 登录账号/密码置顶且只出现一次；供应商名称/邮箱/编码/联系人/结算邮箱不再作为表单和公开字段；内部唯一身份由登录生成。保留币安 ID、采购单价、汇率、倍率、合同版本与独立运营备注 |
| 统一账单 | 上游账单和下游账单同页；选择一个或多个直属下游、包含首尾日的账期、时区、汇率来源、调整项，预览实际用量与合同价格后生成草稿；确认后下游可见，付款登记仍为记录已完成的线下付款 |
| 结算一致性 | 15 分钟预览令牌绑定操作者/付款方；固定合同、价格、事实和水位，变化须重新预览；每付款边逐请求分配及幂等键阻止重复结算，迟到事实可补单，作废仅释放本单分配；旧账单保留占用周期 |
| 操作记录移除 | 删除供应商菜单、页面分支、审计读取接口及死代码；后台业务审计写入继续用于追溯，历史审计数据保留 |

### 数据、权限与清理

- 新迁移 `070_vendor_settlement_previews.sql` 保留已发布 067 平台合同价格、068 运营备注；增加预览/分配表及账单幂等字段，移除旧的同合同同周期唯一限制。重建账单表时逐行保留原账单、付款、状态和引用；迁移测试含已付款账单及外键完整性校验。未修改已发布历史迁移。
- 新门户生成草稿采用 token + idempotency_key 契约；旧直接周期 POST、分离 GET settlements/payables、usage/summary、audit-logs 的门户实现已退役。运营平台的现行周期结算接口继续保留，付款登记组件共用且服务端付款边隔离。
- 旧身份/联系数据库列为已部署内部身份及历史记录保留，不重写生产数据；应用停止暴露/编辑已取消字段。历史账单快照通过只读投影兼容，不改写原 JSON。
- 已知限制：没有新增付款冲正、收款争议、跨合同周期自动拆单、结算导出。历史事实没有缓存/延迟时不虚构指标。账号启用仍受有效授权、代理健康、VM 运行状态和平台策略约束。

### 验证与验收边界

- 定向覆盖供应商/运营接口、身份与权限刷新、上下级隔离、代理/分组实际绑定、平台类型防伪、暂停/归档/冷却、请求聚合/自然日边界/历史留存、结算预览/幂等/价格变更/迟到补单/付款权限及迁移。
- 本机浏览器使用隔离模拟供应商账号，核对完整抽屉、七项用量指标、固定窗口、趋势/模型图、编辑、平台联动、统一代理框、供应商表单和账单流程。测试凭据和代理均为模拟资料，不作为真实 OAuth 换票或 Linux guest 启动成功的证据。
- 当前主机缺少 Linux guest 运行条件；VM 自动启动的成功分支和真实供应商凭据仍需 Linux 服务器验收。没有执行生产部署或生产数据库迁移。

验收记录（2026-10-30）：供应商/运营/代理定向 Node 测试 74/74；统一命名及结算合同复用后的受影响补测 41/41（与前者有重叠，不相加）；前端模型/授权启动/四语完整性 16/16；TypeScript 与 Vite production build 通过。浏览器验证统一代理框的粘贴/下拉/键盘 Escape、切平台清空旧分组、完整详情/用量、编辑保存、精简供应商表单及结算预览/草稿幂等。生产构建保留已有大于500KB的分包提示，不是构建失败。

补充约束：供应商添加账号就是创建同一个后台 VM。运营创建与供应商预配共用 `vm-create-config.mjs::buildNewVmRecord`（平台类型、默认并发/RPM/会话/权重、运行配置与初始调度状态），自动命名共用 `newVmNaming`；供应商适配层只加归属及限定代理。供应商创建接口拒绝机器规格、运行环境、并发、权重等字段；修改仅允许授权、分组、名称、备注和自有代理，其他 VM 配置由超级管理员修改。最新公共创建配置与 HTTP 权限回归 21/21，通过超级管理员 API 核对同一 VM 的 ID/名称/平台。

新建供应商 VM 的内部 ID 也统一使用标准 vm-NN 分配；保留旧 vendor-vm-* 记录及其关联，不迁移或改写现有资源。供应商对配对 VM 资源的直接 PATCH/DELETE 被拒绝，统一由账号操作驱动关联状态。


### 双端账号池统一（最后验收修订）

- 超管与供应商均渲染同一个 `AccountWorkbench`，相同概览、筛选、故障分类、列显隐、排序/分页、配额/费用/缓存列与操作布局；删除被替代的简化 `AccountTable` 及专属详情弹窗。角色只改变可见供应商范围、写权限和超管专属 VM 详情入口，不保留两套表格模板。
- 详情、用量与编辑弹窗共用同一组件，API 根路径分别为 `/api/vendor/accounts` 与 `/api/admin/vendors/accounts`；超管 GET详情/usage、POST冷却清理沿用相同脱敏投影和作用域校验。选择某供应商时按资源实际所有者筛选，避免把下游混入自己的列表；父级停用的后台级联仍显式包含下游。
- 前端静态渲染回归验证：同一数据在两种身份下生成完全相同的 table DOM；未知用量/配额不显示虚构的0。两端 HTTP 读取同一账号的分组、VM ID和统计汇总相等。完整后端定向回归76/76、前端账号池与四语回归11/11、类型检查及生产构建通过（其中历史统计修订补测单独记录，数量不叠加）。
- 第二轮交付合并保护同期独立 main `97b878970078c4af3f8df7e8080097346d6773a7`：保留管理域授权/充值、删除服务提供商入口、Codex未知窗口修正；保留其共享展示要求，并以完整账号池组件替代其过渡简化表格。上游父提交保持8cb05ff。

最终候选同时保留独立 main `53d50ec51ec5bb1b082ec5aa3b0a70de0a50619e` 的已完成用量计费修订及069迁移；本次未发布的结算迁移顺延至070。没有修改已发布迁移。最终验收截图记录同一供应商10条资源、相同14列表头与完全相同的vm-04行；超级管理员用量弹窗亦实际打开成功。

最终集成验证：96项后端/数据库/供应商用例中，新增070后的两处迁移清单断言先被检出并修正；完整数据库升级、完成用量升级和供应商结算补测均通过。前端两种角色同一table DOM、未知状态及四语检查11/11，TypeScript/Vite构建通过；其余已通过且输入未变的用例沿用本轮证据。


### CI收口：种子设置与旧测试契约

首次推送0126775d的GitHub前端、契约和ARM验证通过，完整Node隔离套件暴露8个文件中的旧断言与一处实际接口回退。按同一上游父提交8cb05ff逐函数比对后，恢复GET/PUT seed-settings及读取助手的上游实现：从实际节点读取文件、安全拒绝符号链接、遥测日志只返回白名单字段、区分配置保存/发布/生效、geo等待后重读VM并按拥有字段合并。供应商仍无权读写该超级管理员配置接口；没有改动角色授权或业务需求。

旧测试修正tapmodels launchd标签、046集群平台迁移、管理员域仓储替身、异步配置revision的await/reject、zero保留调用方system及新版eager_input_streaming协议字段。缓存标记、TTL、调用方消息与权限断言保留；不通过删测试或放宽生产逻辑换取通过。Codex陈旧socket测试改为真实关闭监听器后遗留的socket inode，消除普通文件在macOS/Linux上连接错误不同造成的误判。停机VM遥测测试使用隔离的模拟Docker读取接口，禁止触碰开发者真实Docker容器。

这8个文件的133项定向测试全部通过。前端实现与已通过的双端浏览器验收输入未变，不重复构建；原CI失败由这一修订替代，新的远端CI状态另行报告。

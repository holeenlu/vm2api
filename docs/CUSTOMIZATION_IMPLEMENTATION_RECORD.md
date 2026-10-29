# TapModels 定制实现总记录

更新日期：2026-10-29

本文是 tapmodels/vm2api 定制代码的统一需求、规划、实现和验收记录。它与 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 配合使用：本文件按功能说明“为什么做、怎么规划、改了什么、如何验证”，Release Note 记录版本交付、升级、清理和限制。两份文档随同唯一的定制提交交付。

## 交付基线与历史形态

本次整理使用的上游是 `dofastted/vm2api/main@75a18df27b9d77b3d95029c58f24301120fb70b2`（v1.4.025）。截至本记录日期，实时上游仍为该提交；最终交付保持：

```text
75a18df27b9d77b3d95029c58f24301120fb70b2
└── tapmodels 定制提交
```

最终 main 只保留一个定制提交。此前按功能产生的定制提交、同步候选和临时合并树均不进入正式历史，完整恢复材料保存在仓库外 bundle 中。

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

- 供应商开户使用独立供应商平台流程，供应商填写平台、授权、代理、区域、语言和运行环境等开放参数。
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

# Gateway Worker UI/UX 与业务交互

更新于 2026-11-01。本页描述最终页面和交互。所有页面沿用 vm2api 当前 AuthenticatedLayout、侧栏、页面头、卡片、表格、抽屉、Dialog、分页、筛选、Toast、四语 i18n 和权限裁剪。Gateway Worker 不另造供应商门户或登录体系。

## 1. 导航和角色

现有菜单顺序保持：

    运营管理：总览、统计、使用记录、用户、API 密钥、充值记录
    供应商平台：供应商管理、账号池、代理管理、用量统计、结算对账、结算设置
    资源管理：分组、集群、虚拟机、导入、规格、代理池、Gateway Worker
    系统管理：模型、上游 API、Anthropic、风险审计、系统提示词、设置、内核、数据库

Gateway Worker 放在资源管理的“虚拟机”之后，只对 super_admin 或 gateway_worker.ops.read/manage capability 可见。普通 admin、user、vendor 手工访问深链仍返回权限错误；供应商门户不增加 Fleet/Server 菜单。

| 角色 | 可见页面 | 可见数据 |
| --- | --- | --- |
| super_admin | Worker、账号池、供应商策略、用量、结算 | Fleet/Server 运维字段、全量账号执行摘要 |
| admin | 现有管理域页面 | 用户/Key/消费投影；不读 Worker 运维和供应商凭据 |
| vendor | 供应商账号、代理、用量、结算 | 自有账号 execution_kind 和安全可用性摘要；不读 Server/Fleet/Dispatch |
| user | 分组、API Key、使用记录、统计、账单 | 本人数据；可显示执行方式聚合标签，不显示内部资源 |

## 2. Worker 运维页

顶部统计卡显示 Fleet 总数、healthy/draining/offline Server、active/max 并发、队列深度、pending Receipt 和 capability mismatch。未知容量显示“—”，不显示 0；局部读取失败不让整个页面变成 500。

筛选字段：Fleet、区域、状态、版本、能力、关键字、每页 10/20/50/100。

Server 表格列：名称、Fleet、区域、版本、能力、active/max 并发、队列、最后心跳、更新时间、操作。行操作是详情、Drain、Resume；Drain 说明停止新 Dispatch、让在途请求完成。批量 Drain/Resume 只作用于当前筛选内有权限的 Server，部分失败逐项反馈。

详情抽屉分为基本信息、健康、能力、容量、Receipt 和最近事件。供应商和用户不能打开该抽屉；账号详情只显示“可用 Server 数量”和安全原因。

## 3. 账号池工作台

超管和供应商继续共用 AccountWorkbench。共享表头、筛选、详情抽屉、分页、状态标签、批量暂停/恢复、导出和自动刷新；角色只改变范围、列和操作。

| 列/区域 | VM | Gateway Worker |
| --- | --- | --- |
| 执行方式 | VM | Gateway Worker |
| 执行摘要 | VM/槽位/代理/调度 | capability、可用 Server 数、availability |
| 运行状态 | ready、cooldown、paused、archived | ready、executor_unavailable、paused、archived |
| 容量 | account concurrency、RPM、窗口 | account concurrency、RPM、窗口 |
| 供应商操作 | 名称、备注、分组、代理、暂停/恢复、归档、授权 | 同左，不提供 Server/Fleet 选择 |

供应商不显示供应商列、Fleet、Server、Dispatch、credential revision 和完整上游错误。超管可显示执行方式和 Worker availability，但 Worker 运维进入独立页面。

## 4. 新增账号 Dialog

### 4.1 共同行为

- 使用现有 Dialog 滚动、Escape、取消和失败保留草稿行为。
- 创建从短期 account draft 开始，草稿 30 分钟过期。
- 关闭 Dialog 不取消已发出的授权任务；再次打开根据 draft 状态继续。
- 目录加载、无匹配分组、策略失效或能力未知时禁用提交。
- 所有文案进入 i18n，不写硬编码业务文案。

### 4.2 步骤

1. 平台；
2. 执行方式；
3. 认证方式和代理；
4. 分组和账号限制；
5. 授权/验证；
6. 创建摘要和提交。

平台切换时清理不适用的认证方式、分组和模型。执行方式卡片只显示 VM 或 Gateway Worker；Worker 卡片不出现 Pool、Fleet、Server、Instance 选择框。只有一种可选时自动选中，两种都关闭时显示策略原因。

认证选项来自平台和 Worker capability 交集，例如 OAuth、Setup Token、Console API key、账号文件。代理沿用现有 combobox：自动、既有代理、新代理。空编辑输入表示不修改旧值。

分组列表只包含当前供应商有效授权、平台匹配、执行方式允许、非归档且非停用的组。至少选一个分组。供应商不能提交 execution_kind、VM 参数、Server、Fleet、owner 或真实成本字段。

状态显示：

    draft → authorizing → credential_verified
      → provisioning（VM only）
      → ready / executor_unavailable / error

Worker 没有健康 Server 时，凭据验证成功但执行容量不可用，显示“已保存，当前不可接流量”，不显示凭据错误。

## 5. 编辑、暂停和迁移

供应商可编辑 name、notes、group_ids、proxy；超管从现有 VM/运行配置入口编辑 VM 专属参数。execution_kind、platform、owner、Server、Fleet 不可编辑。切换方式使用复制/迁移流程。

保存请求携带 expected_updated_at、expected_config_revision、expected_credential_revision。冲突显示“数据已更新，请刷新后重试”，不覆盖后台刷新凭据。

暂停立即挡新请求，默认已发送请求排空；恢复只解除本次暂停。归档先挡新请求并处理在途/刷新租约，再释放代理引用；Worker 归档不停止共享 Server。

## 6. 供应商执行策略页

位置：供应商管理 → 供应商详情 → 执行策略。

按平台显示：

    Claude / VM             [允许创建] [允许运行]
    Codex / Gateway Worker  [允许创建] [允许运行]

保存 Dialog 显示当前 revision、关闭创建不删除存量、关闭运行先停止新 Dispatch、操作者和保存时间。供应商只能读取策略结果，不能修改；二级供应商沿父级有效范围取交集。

## 7. 分组、Key、用量和结算

分组页资源类型增加 gateway_worker_account，Fleet/Server 不进入资源选择器。综合组可以按平台授权 Claude VM、Codex Worker；只有协议、计费和会话语义兼容时才允许同平台混合。

Key 创建 Dialog 继续只选择分组，不出现 VM/Worker/Server 下拉框。使用记录可以增加 execution_kind、account_resource_id、attempt_id、usage_confidence 聚合；隐藏 Server、Fleet、Dispatch 和凭据版本。

供应商用量、超管用量、用户使用记录继续沿现有页面。unknown/partial 显示“待核对/部分已知”，不显示 0。结算只使用 vm2api 的价格版本、usage facts 和 payer/payee；Worker 不产生价格字段。

## 8. 权限和失败提示

统一错误码：

    execution_policy_forbidden
    execution_kind_unsupported
    group_required
    group_scope_forbidden
    worker_capability_mismatch
    worker_server_unavailable
    worker_server_draining
    dispatch_expired
    dispatch_replayed
    credential_revision_mismatch
    receipt_duplicate
    usage_unknown

403 显示无权限状态，401 清理 session 和 Query 缓存，网络错误局部重试，空列表区分无账号/无分组/无执行容量，stale 保留未提交草稿，pending 禁止重复提交，unknown 显示未知/待核对。

## 9. 响应式和可访问性

桌面沿用当前表格最小宽度和详情抽屉；窄屏统计卡两列排列、表格横向滚动；Dialog 在 760px 以下改为单列。按钮有 disabled/loading/success/error 状态；状态同时使用文本和 aria-label；Drain、归档、删除有键盘可操作确认 Dialog。

## 10. 页面验收

1. 供应商策略关闭 Codex Worker 后，创建表单只显示 VM 或无可用方式。
2. 同一综合分组和同一 Key 调 Claude/Codex，执行方式分别正确。
3. 账号详情不显示永久 Server 绑定。
4. Worker 运维页只对 super_admin/ops capability 显示。
5. 供应商门户没有 Fleet/Server/Dispatch 菜单。
6. VM 账号原有创建、授权、详情、用量和归档页面不回归。
7. pending、unknown、partial、offline、draining 都有独立页面状态。
8. 四语、加载、错误、空列表和退出登录行为与 vm2api 当前页面一致。

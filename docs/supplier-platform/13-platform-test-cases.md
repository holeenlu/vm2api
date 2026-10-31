# 供应商平台测试用例与证据

日期：2026-10-30。需求映射见12审查报告。用例使用隔离SQLite、标准HTTP会话和模拟上游；不得使用真实生产账号/付款替身得出生产成功结论。

## 准备

测试身份：SA、AD、U；V1-A（可创建下级）、V1-B（不可创建下级）、V2-A（A的子级）、V2-C（另一父级）。配置Anthropic、OpenAI及按模型范围限制的mixed组；各供应商独立代理；账号/代理有限额与0不限额两类。结算身份分别有/无settlement.pay。

## 可重复执行的用例

| TC | 需求 | 操作/输入 | 预期结果 | 自动覆盖 |
| --- | --- | --- | --- | --- |
| 01 | R01–03 | 各角色访问管理/供应商页面、接口；无create_child访问/vendors | SA可治理；AD/U/跨层越权拒绝；无能力不显示菜单，后端403 | vendor-platform/review/admin HTTP与角色测试 |
| 02 | R02–03 | 创建子级传他人user_id、越级cap、超过有限配额；child_limit=0重复创建 | 拒绝身份窃用/越级/超额且无半成品；0不限但受父级总额 | vendor-platform/review单元与HTTP |
| 03 | R03/R15 | 同key并发开户、改输入重放、归档后重放 | 同一记录或409，不重复用户/VM/扣额，不恢复归档 | S03/HTTP S11/S12 |
| 04 | R04 | 同一数据分别渲染SA/供应商表格，按相同供应商查询 | 共享数据与统计一致；供应商端隐藏供应商列并调整宽度，SA保留供应商列；角色操作与可见范围不同 | account-workbench.test.tsx；HTTP双端对照 |
| 05 | R05/R07 | Anthropic/OpenAI切换，使用不匹配授权/分组 | 清旧选择；只显示匹配组；后端拒绝伪造；正确VM类型 | vendor-account-usage、vendor-platform HTTP |
| 06 | R05 | 空名称、重复新建、残留旧目录、历史编号 | 标准vm-NN，不覆盖旧文件或凭据；两端同一VM | panel-vm-create；A04；HTTP标准编号 |
| 07 | R06 | 无匹配组、满额代理、配置回调失败、写入后DB触发器失败 | 数据库、代理绑定、分组和新VM文件一起回滚，重试可成功 | A01–A03；HTTP满额 |
| 08 | R06 | 预配完成但运行环境启动失败 | 201带失败runtime_boot，账号可见，不能声称已开机 | vendor-platform HTTP |
| 09 | R08 | 创建/更新提交runtime、machine、weight、max_concurrency、family | 供应商拒绝；SA从VM配置入口修改；无旁路PATCH | vendor-platform HTTP |
| 10 | R08 | name+notes+paused同次更新；失败版本号 | 账号/配对VM/运行VM名称状态同步，旧版本409 | HTTP Atomic rename/config版本 |
| 11 | R07/R10 | 改实际group_resources，撤销父级平台/分组后再授权/发起调度 | 不信旧JSON副本；目录与写入即时收紧，供给拒绝 | A05；HTTP目录/授权撤销；S05/S06 |
| 12 | R08 | 已选组被撤销，再打开编辑 | 失效项可取消不可重新选择；两端目录按账号归属过滤 | editableGroupOptions；HTTP /groups |
| 13 | R09 | URL/四段代理、重复代理、其他供应商代理、无效地址 | 同一个输入框；正确归属/去重；拒绝越权，响应无凭据 | vendor-platform/portal-view；HTTP |
| 14 | R10 | 暂停/恢复/归档、删除后再次授权、旧磁盘schedulable=true | 成对状态一致；归档不可恢复；不清平台停调 | S05/S06、HTTP S12、vendor-audit |
| 15 | R11 | 真实AccountsRepo存93%/100%窗口及官方reset；清临时冷却 | 临时冷却可清；百分比、reset、rate_limited状态和保护保留 | HTTP audit-quota |
| 16 | R12 | 请求有Token/费用/失败；切日期/时区；读固定窗口 | 各指标同源；输入输出与缓存分开；固定窗口不受日期筛选影响 | vendor-account-usage.test.mjs |
| 17 | R12 | logging=off使用供应商VM，再裁剪详细日志 | 摘要/成功事实幂等保留，无正文；无缓存历史显示未知 | A06；request-log；vendor-admin留存用例 |
| 18 | R13 | 创建下级填默认/Anthropic/OpenAI单价；非法参数或高精度 | 分平台价进合同快照；非法输入无登录半成品，按十位规范化 | signup结算设置；A12 |
| 19 | R14–15 | 预览后改费用、合同、Token或使用过期/他人token | 旧预览拒绝；不会静默换价格或账户 | vendor-settlements/review |
| 20 | R14–15 | 同期迟到用量补单、重复生成、作废、确认0元 | 每付款边逐请求防重；仅释放本单分配；0元paid且无假流水 | vendor-settlements A07与分配回归 |
| 21 | R14–15 | 未定价零Token、缺平台、有损坏价格JSON | 明确错误，费用未知，不默认为0或使用便宜默认价 | A08/A09/A11 |
| 22 | R15 | 无付款权限、跨付款边、重复/超额/微小付款 | 拒绝越权/超额；按既有六位规范化，最小单位与幂等 | S09/HTTP S11；A10 |
| 23 | R16 | 创建期间关闭弹窗；跨平台网络重试；目录加载中 | 不丢失进行中的预配；不能用返回的其他平台VM继续授权；加载时不可提交 | 受控Dialog/prepareVm；定向浏览器检查 |
| 24 | R16 | 内部SQL错误或启动错误带敏感细节 | 公开响应仅业务码/可用提示，不回显底层内容 | HTTP fail-reviewed；脱敏测试 |
| 25 | R16 | 四语切换、未知值、同scope两端渲染 | 无硬编码界面文案，未知不显示null/伪造0 | i18n coverage、portal-model、account-workbench |
| 26 | R04/R16 | 点击账号名称、点击操作列信息、供应商与SA分别打开账号池 | 账号名称复制并显示成功提示；名称不误打开详情；信息入口打开侧栏，标题优先显示邮箱，详情字段与配额/冷却/运行指标顺序一致；供应商端不显示供应商列 | account-workbench.test.tsx；AccountIdentity；AccountDetails；TypeScript/Vite |
| 27 | R04/R16 | 一条正常暂停账号、一条 OAuth access token revoked 账号、一条已归档账号分别选择状态筛选 | “停用账号”只返回 `paused`；“异常账号”返回认证撤销和 `archived`；归档条件仍可单独查看历史账号，三类不会互相混入 | vendor-account-filters.test.mjs；account-workbench；HTTP双端对照 |
| 28 | R04/R16 | 供应商只授权一个分组，打开“添加账号”并切换平台 | 弹窗只显示当前供应商已授权且匹配当前平台的分组；未授权分组不显示，直接伪造未授权 group_id 仍由后端拒绝 | account-create-form.test.ts；vendor-platform accountGroupIds |
| 29 | R01/R16 | 供应商点击退出登录 | 清理供应商会话、Query 缓存和服务端 session，返回 `/console/#/welcome` 对应的 `/welcome` 路由，不回到供应商登录页 | access-state；VendorPortalPage |

## 复现命令

Node 24，安装仓库锁定依赖后运行：

```sh
node --test --test-timeout=30000 test/unit/vendor*.test.mjs test/e2e/vendor*.test.mjs test/unit/request-log.test.mjs test/unit/panel-vm-create.test.mjs test/unit/slot-shell-rc.test.mjs test/unit/panel-billing-lookup.test.mjs test/unit/schedule-eligibility.test.mjs test/e2e/usage-refresh.e2e.test.mjs
cd web
node node_modules/vitest/vitest.mjs run src/features/vendor src/i18n/coverage.test.ts
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
```

本轮上述后端组合200项通过。前端在最终表单更新后补跑对应测试/类型检查/生产构建；详细最终数量以交付记录为准，不将多次重复运行相加。

## 必须另行执行的真实环境用例

| TC | 场景 | 必须核对的结果 |
| --- | --- | --- |
| L01 | 在授权Linux环境创建Anthropic/OpenAI账号并完成真实授权 | 标准VM实际启动、代理出口一致、凭据不回显，供应商/SA同时显示同一实例和合法分组 |
| L02 | 真实请求、上游限流、额度查询/重置、服务重启 | 窗口与解除时间持久化、请求/费用事实不重复、7D预测按有效比例计算 |
| L03 | 运行中代理切换、父级撤权、断网/进程崩溃 | 不错绑、不越权、不把未确认操作显示成功；恢复路径和残留资源可解释 |
| L04 | 升级、备份恢复、长周期日志裁剪和财务核对 | 合同/已付款单/用量保持，未知历史不补造，两个付款边各自对账 |

这些用例没有用真实生产环境执行，不能标为通过。


## 2026-10-30 当前验收用例增量

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| G01 | SA 读取/追加全局价格版本 | GET 成功，POST 成功；其他角色 POST 返回 403 |
| G02 | 保存幂等 | 相同幂等键返回同一版本，参数变化返回 409 |
| G03 | 上海生效日 | 生效日期按北京时间 00:00 选择规则，边界前后价格不同 |
| G04 | 同日调价 | 同一生效日期按最新版本优先，旧版本仍保留历史状态 |
| G05 | 跨版本账期 | 按请求发生时间和平台拆分金额，返回 pricing_versions 与明细 |
| G06 | 多供应商/两条付款边 | 所有供应商使用相同价格，账单 payer/payee 独立且不被价格版本覆盖 |
| G07 | 账单冻结 | 新增价格版本后，已生成账单金额、价格和付款记录不变化 |
| G08 | 旧字段清理 | 新建/编辑供应商、用户及账单预览携带旧价格字段均被拒绝 |
| G09 | 无规则保护 | 首个全局规则前的新供应商不能猜价结算 |
| G10 | 代理/账号/权限回归 | 供应商只能使用自有代理，只能修改名称、备注、授权、分组和代理；VM 参数仍由 SA 管理 |
| G11 | 超管代理池工作台 | 按供应商筛选并显示协议、脱敏地址、延迟、地区、质量、绑定席位；连接/质量/地区批量操作只作用于当前范围 |
| G12 | 代理池编辑与状态边界 | 地址/认证编辑同步 `vendor_resources`、统一池和绑定 VM；无效状态不改变池；启停同步门户；绑定中的代理不能归档 |
| G13 | 管理员打开使用记录 | 首屏加载态结束后，统计、活跃会话、筛选选项、列表和排行响应为空或存在旧兼容字段时仍显示页面；接口错误在局部区域提示，不触发全局500 |
| G14 | 供应商/运营账号状态一致 | 同一账号在运营平台与供应商平台展示相同的正常、准备中、冷却、暂停、归档和不可调度状态；凭证吊销、调度关闭及具体不可调度原因同步显示；调度开关与后端可调度结果一致 |
| G15 | 超管代供应商添加账号 | 超管选择供应商后，使用与供应商端相同的平台、名称、代理、分组和授权方式；创建后账号归属所选供应商，并直接进入授权面板；授权完成后供应商端可见同一账号 |
| G16 | 新建/编辑用户的分组授权 | 分组授权使用可搜索多选样式，选中项高亮；不显示专属倍率、专属 RPM 或默认 `1x`；保存后用户只保留分组授权和分组默认限制 |
| G17 | 全部日期/时间入口 | 日志、供应商用量、供应商结算、供应商账单、账号池和单日期配置使用统一日期组件；快捷范围、双月日历、清空/取消/确认可用，日志还可设置开始/结束时间 |
| G18 | 充值记录与消费流水 | API 使用扣费仍改变余额并保留用量/结算事实，但不写入充值记录；历史 usage 钱包流水清理后，充值、转账、冲正和开账流水仍可查询 |
| G19 | 供应商账号分组范围 | 创建和编辑账号只显示运营后台已授权且匹配平台的分组；供应商无授权分组时列表为空；接口提交未授权分组返回范围错误 |
| G20 | Claude 上游账号故障原因统一投影 | 分别注入 OAuth 吊销、组织不允许 OAuth、访问令牌过期、Consumer Terms/Privacy Policy 未接受和代理不可用；供应商账号池与运营 VM 使用相同稳定原因码和对应中文标签，暂停调度的四类原因不可继续分配，代理凭据不出现在响应或页面 |
| G21 | 账号池与虚拟机异常/冷却悬浮状态 | 供应商账号池和 VM 列表的异常统一显示“异常”，两处均可悬浮查看具体安全原因且只显示原因文本；冷却显示具体恢复时间；吊销/失效内部仍归入 `revoke`/`bad` 筛选；正常、冷却、暂停、归档的主标签保持既定语义 |
| G22 | 供应商编辑代理地址 | 编辑代理默认地址输入为空；留空保存不修改原地址；输入 `socks5://user:password@host:1080` 可更新地址并在列表显示协议格式；新增代理仍要求地址 |
| G23 | 供应商代理管理与运营后台代理池一致 | 供应商端名称统一为“代理管理”，表格显示供应商、协议、地址、状态、延迟/质量、地区和绑定席位；协议/状态筛选、汇总数量和分页生效；供应商只能暂停/恢复自己的代理，不能执行运营后台代理池检测、编辑或归档操作 |
| G24 | 超管代供应商添加账号的分组与授权方式 | 选择供应商后，只显示该供应商已授权且匹配所选平台的分组；Anthropic/OpenAI 授权方式随平台切换；提交数据同时满足前端展示规则和后端供应商范围校验 |
| G25 | 运营后台代供应商账号目录 | 运营后台选择供应商和平台后，通过后端同一授权目录显示供应商可用分组；切换平台重新加载；Anthropic 显示 OAuth/Setup Token/Console，OpenAI 显示 OAuth/账号文件 |
| G26 | 混合分组与账号分组必选 | 运营平台创建为“混合”的 Coding 分组在 Anthropic/OpenAI 两个平台均可选择；供应商新建、编辑及运营后台代创建账号未选择分组时前端阻止提交，后端返回 `group_required`；不再显示“未选择时使用系统默认分组”文案 |

自动化入口：`test/unit/vendor-global-pricing.test.mjs`、`test/unit/vendor-admin.test.mjs`、`test/unit/vendor-settlements.test.mjs`、`test/e2e/vendor-admin.e2e.test.mjs`、`test/e2e/vendor-platform.e2e.test.mjs`、`test/e2e/vendor-review.e2e.test.mjs`。代理池工作台 G11/G12 由 `vendor-admin.e2e.test.mjs` 覆盖，前端由 i18n、TypeScript、lint 和生产构建覆盖。

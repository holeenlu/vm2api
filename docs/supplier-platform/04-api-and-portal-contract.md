# 供应商 API 与门户契约

更新于 2026-10-30。当前接口如下；未列出的规划端点不得据此认为可调用。登录复用面板 session，供应商资源范围由服务器独立验证。

## 当前供应商接口

| 方法 | 路径 | 行为与权限 |
| --- | --- | --- |
| GET | /api/vendor/me | 当前有效成员、供应商、能力和视图 |
| GET/POST | /api/vendor/vendors | 一级 + create_child；POST 创建独立下级登录，不接受 user_id；幂等重试 |
| GET | /api/vendor/vendors/:id | 自己/直属允许范围；目前没有 PATCH 子级策略接口 |
| GET/POST | /api/vendor/accounts | 自有账号列表/开户；POST 创建配对 VM，绑定自有代理和分组，返回真实 runtime_boot |
| GET/PATCH/DELETE | /api/vendor/accounts/:id | 自有详情、name/status、成对归档；父级聚合不授予写权限 |
| POST | /api/vendor/accounts/:id/pause 或 resume | 供应商独立供给暂停；不清除操作员停调与凭据保护 |
| GET | /api/vendor/vms 或 /vms/:id | 配对 VM 资源；POST /vms 拒绝直接开户 |
| PATCH/DELETE | /api/vendor/vms/:id | 允许字段与配对生命周期，归档不能恢复 |
| POST | /api/vendor/vms/:id/start 或 stop | 调用真实运行时，错误不伪装成成功 |
| GET/POST | /api/vendor/proxies | 自有代理列表/新增，绑定统一池；入池失败回滚 |
| GET/PATCH/DELETE | /api/vendor/proxies/:id | 脱敏详情、name/status、归档；地址编辑/检测尚未实现 |
| GET | /api/vendor/usage | 开始含、结束不含的 UTC 期间查询，供应商/账号/模型维度 |
| GET | /api/vendor/usage/summary | 事实累计摘要；无 create_child 时只看自己 |
| GET | /api/vendor/audit-logs | 当前范围业务审计；不含凭据 |
| GET | /api/vendor/settlements、/payables、/billing | 自己的收款边、允许的下游付款边及共享账单档案 |
| POST | /api/vendor/settlements/preview、/settlements | 一级 + create_child + settlement.read，预览并生成直属下级账单 |
| POST | /api/vendor/settlements/:id/confirm、payments、void | 一级 + create_child + settlement.pay，且必须是该账单真实付款方 |

资源列表 vendor_id 省略/自己为自有；all 为具备能力的一级及直属子级；具体子级必须属于当前树。账号开户重复成功返回 200、reused=true，不重新绑定代理或启动；首次 201。下级开户同 key 重试返回原主体；冲突参数 409。

供应商的官方授权沿用受保护的 `/api/panel/vms/import`、OAuth 生成/换码和登录终端路径。服务器核对有效主体、成员、能力、成对资源及归属；供应商 shell-ticket 必须 login=true，实际执行固定 auth login，不能申请普通 shell。授权票据和提交前重新校验；完整异步 claim 仍属后续任务。

## 当前超管接口

`/api/admin/vendors` GET/POST，`/:id` GET/PATCH。新建可 username/password 原子创建登录，也可绑定未占用的普通账号；编辑可配置 create_child 与 settlement_pay。archived 主体只读。

超管新建表单仅提供登录账号、密码、币安 ID、备注和供给/结算设置；省略 name/email/external_code 时，服务端按绑定登录账号生成内部身份值。PATCH 省略旧身份与联系人字段时保留原值。`remark` 为超管备注字符串（可空，最多 1000 字），仅超管列表、详情与写入响应暴露，不进入供应商 `/me` 或结算档案。

采购价格以 `group_prices: { anthropic?: number, openai?: number }` 传入，平台单价必须为有限正数。表单按勾选平台展示 Claude/Codex 单价，移除统一单价输入；现有统一单价字段仍用于历史合同及独立开户调用方。合同通过迁移 067 保存 `group_prices_json` 快照，修改价格生成新版本；迁移前合同保持 `{}` 与原单价。预览新增 `group_prices`、`rate_breakdown`（平台、官方价费用、采购单价、应付金额），并纳入现有 preview_token；按账号平台拆分计价，未知平台且有非零用量时拒绝分平台结算。迁移 068 添加供应商备注；不删除任何旧数据。

accounts/proxies 分区提供 GET/POST 列表开户、GET/PATCH/DELETE 详情及 POST pause/resume；POST 必须明确供应商，资源 ID 和 vendor_id 不一致拒绝。超管可查看所有资源，但不通过伪造 supplier 参数放宽普通供应商请求。

`/usage` GET；`/settlements` GET/POST；`/settlements/preview` POST；`/settlements/:id/confirm|payments|void` POST。超管只操作平台→一级付款边，下游付款边只读。`/api/panel/providers` 保留供应商账号的只读运营视图，不包含平台自建 VM。

## 响应与前端

成功 `{ok:true,data:...}`，失败 `{ok:false,error:{code,message}}`。本轮没有实现通用响应 meta.request_id/policy_revision 协商，不应把设计示例当作现有响应字段。

超管 `/suppliers/suppliers|accounts|proxies|usage|settlements`；供应商 `/vendor/accounts|proxies|vendors|usage|billing|audit`，菜单随实际能力变化。下游付款组件与超管共用，但 endpoint 和付款边分别验证。下游生成先预览，付款登记不发起转账。

页面目前列表分页/搜索主要在前端完成；全量数据的服务器分页、报表导出和独立门户版本协商仍未完成。统计不能回退无日期累计快照。未知额度/TPM 不用 0 或累计 Token 冒充。

## 未实现端点

子级策略 PATCH、批量账号/代理导入预览与导出、代理 test/quality-check、供应商专用授权撤销与额度主动刷新、收款确认/争议、付款冲正/调整、结算导出、超管 group-supply/audit/identity-reconciliation。需求保留在 07/08 文档，不能用普通超管 API 暂代供应商权限。

# 安全、审计与隔离

更新于 2026-10-30。当前措施、已修复边界与后续要求分别记录。

## 2026-11-01 Gateway Worker 安全边界

Gateway Worker 只接收 vm2api 签发的短时 Dispatch Lease、账号凭据快照和代理快照，不持久化用户 API Key、分组、钱包或完整账号池。注册、心跳、能力上报、Dispatch、Cancel、Receipt 和 Drain 使用 mTLS 或短时签名，并校验 Server enrollment、账号凭据版本、过期时间和 replay protection。普通 heartbeat token 不能读取账号凭据。

Worker Server 故障只更新 Server 健康，不直接停用账号；账号暂停、供应商策略撤销和分组撤权由 vm2api 控制面在所有执行方式上统一生效。运维日志可记录 `worker_server_id`，供应商和终端用户投影不得返回 Server、Fleet 或 Dispatch 敏感字段。

## 2026-11-01 Worker 凭据和网络边界

Worker 只接收一次 Dispatch 所需的短时凭据/代理快照或加密 envelope；不接收用户 API Key、分组、钱包、价格、完整账号池或供应商结算资料。凭据快照带 credential_revision、过期时间和 request/attempt 绑定，Server 只能使用被授予的账号和租约。

Heartbeat 只允许上报健康、版本、能力、并发和队列；不能以 heartbeat token 读取凭据。注册和 Dispatch 使用 mTLS 或短时签名，校验 enrollment、Fleet 状态、nonce、lease TTL、replay 和 capability。Server offline、Drain、版本错误只影响执行面，不直接暂停账号。

日志禁止写入 Authorization、refresh token、代理密码、用户请求正文和 Worker token。供应商和终端投影禁止返回 worker_server_id、fleet_id、dispatch_id、credential_revision 或其他租约敏感字段。

## 当前信任边界

供应商复用现有面板 session，角色为 vendor；供应商成员、主体状态和能力在后端重新检查。模型 API Key 不授予供应商管理权限。普通管理员和用户不能进入超管供应商接口，供应商也不能因为可以操作自有 VM 而访问宿主机、平台运维或数据库。

本轮补齐：下级开户不能绑定现有用户，子级不能扩大父级范围/能力；写入前重读成员和能力；资源/合同边分别验 owner/payer；暂停、归档、停用和范围撤销在选号时再次执行；归档账号的配对 VM 不可继续授权或启动。

## 授权终端与异步请求

供应商只能申请 login=true 的单次短期票据，运行固定 `cli-node auth login`，不启动普通交互 shell。签发、连接、输入及会话期间复核权限，撤权关闭会话；操作员原终端行为保持。导入和 OAuth 换码在提交前再次检查归属。

上述检查不等于全系统异步 claim/nonce 已实现。远端授权服务中已经发生的操作、跨进程迟到任务和预配失败补偿仍需专项设计及真实环境验收。

## 敏感数据和持久化

列表/详情使用投影：不返回 token、代理密码、原始上游错误和其他供应商资料。账单仅显示自己相关合同边。密码沿用现有哈希；代理凭据沿用 `secure.mjs` 的**可选**静态加密：配置 TAPMODELS_DB_SECRET（或现有 KIN_DB_SECRET）时加密，否则仍按既有方式保存。配置密钥不等于已自动改写历史明文，本轮未修改运行配置或生产数据。

没有新增独立供应商 JWT、MFA、step-up 或签名导出。`resource.export`/`settlement.confirm` 的预留 capability 不能作为已经完成这些功能的证据。付款登记只是已有登录权限下的业务记账，不调用支付渠道。

## 当前审计

vendor_audit_events 记录 actor_user_id、vendor_id、action、resource_type/id、idempotency_key、payload_json 和 created_at。开户、资源、策略和结算动作使用原审计表；payload 不包含密码/凭据正文。开户幂等保存业务参数摘要而非密码。

全量失败事件、完整 before/after、操作者 IP/UA/policy revision、身份 reconciliation、告警与导出审计尚未全面实现。后续应统一字段和失败审计，不把已有普通运行日志冒充完整证据链。

## 回归检查

- 直接伪造 user_id、供应商范围、下级 capability、付款方 → 拒绝且无半成品。
- 身份读取后撤销成员/能力、停用父级 → 后续写入、付款、连接或调度拒绝。
- 修改缓存 VM schedulable=true → 不能绕过 DB 中暂停/归档/停用与范围。
- 无效代理状态 → 不改变统一池。
- 幂等重放 → 不改代理绑定、不再启动、不重复付款。
- 预览后明细改变 → 拒绝旧预览；历史账单与付款不能被普通 PATCH 改写。

具体自动化用例和未覆盖的真实环境见 07/11 文档。无生产数据盘点、清理、迁移或线上授权验收时，不能声称这些工作已完成。

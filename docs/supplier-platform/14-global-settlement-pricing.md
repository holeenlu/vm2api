# 全局结算设置

状态：已实现并完成定向回归（2026-10-30）。

用户最终确认：所有供应商共用同一套结算机制。OpenAI 单价、Claude 单价、结算汇率和生效日期不属于供应商资料，也不属于用户新建/编辑表单；它们由超级管理员在“供应商平台 → 结算设置”统一维护。

## 规则

- 每次保存追加一个全局价格版本，不能覆盖历史版本。
- 全局版本使用 `vendor_contracts` 保存，`payer_vendor_id` 和 `payee_vendor_id` 均为空；`group_prices_json` 保存 `openai` 与 `anthropic` 两个平台单价，倍率固定为 1。
- 生效日期按 `Asia/Shanghai` 的当天 00:00 保存为 UTC。相同生效日期以版本号较新的规则为准。
- 每条用量按发生时间选择规则；一个账期跨越多个版本时，按“价格版本 + 平台”拆分明细后分别计算，再汇总 USDT。
- 计算公式为：`官方价 USD × 平台采购单价 CNY/USD ÷ 结算汇率 CNY/USDT`，金额按 6 位小数保存和展示。
- 在第一个全局规则生效前，没有历史供应商合同的新供应商不能猜测价格；已有供应商合同只用于读取该生效日前的历史用量。
- 已生成账单保存价格版本、平台、单价、汇率和金额快照，后续修改全局价格不会重算旧账单。
- 账单的付款方、收款方独立保存在 `vendor_settlements.payer_vendor_id/payee_vendor_id`，不从当前全局价格版本推导付款关系。

## 权限与接口

超级管理员使用：

- `GET /api/admin/vendors/pricing`：读取当前规则和历史版本；
- `POST /api/admin/vendors/pricing`：新增版本，字段为 `openai_price`、`claude_price`、`exchange_rate`、`effective_date`、`idempotency_key`。

供应商、管理员和普通用户不能写入全局价格。所有供应商新建/编辑接口、用户管理接口和下游账单预览接口都会拒绝内嵌供应商价格、汇率、倍率、币安 ID 等字段。账单预览不能通过 `exchange_rate` 或 `exchange_rate_source` 覆盖全局设置。

供应商门户的“账单”仍显示上游账单和一级供应商给直属下游生成的账单；下游结算先预览，再提交 `preview_token + idempotency_key`。预览明细展示匹配到的价格版本和分段金额。

## 数据迁移与兼容

`072_global_supplier_pricing.sql` 增加全局价格版本的幂等字段与唯一索引，并把历史账单的付款边从原合同回填到账单表。既有合同、账单、付款、分配和审计数据保留；已应用迁移不修改。新供应商不会自动生成按供应商价格合同。

旧供应商合同只读用于首个全局生效日之前的历史结算。生产写入入口已删除，旧字段仍因历史迁移和历史账单读取保留在数据库中，不再出现在新建/编辑表单或供应商主体投影中。

## 验收用例

- SA 能读取和追加全局版本；其他角色写入返回 403。
- 幂等键重复返回同一版本，参数变化返回冲突。
- 上海时间边界、相同生效日后写版本、未来版本和跨版本账期均按规则计算。
- 两个供应商和上下游两条付款边使用同一组价格；账单所有权不从全局合同错误推导。
- 已生成账单在后续调价后保持原快照。
- 新建/编辑供应商、用户和账单预览不能携带旧的供应商独立价格字段。

对应代码：`src/lib/vendor/vendor-pricing.mjs`、`src/lib/vendor/vendor-settlements.mjs`、`src/lib/vendor/vendor-admin.mjs`、`src/lib/admin/panel-routes.mjs`、`web/src/features/supplier-admin/pricing.tsx`。对应测试：`test/unit/vendor-global-pricing.test.mjs` 及供应商管理、结算和 HTTP 回归。

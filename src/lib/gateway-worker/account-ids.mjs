/**
 * Gateway Worker 账号资源编号：参照槽位 `vm-08`，新账号为 `gw-01`、`gw-02`……
 * 运行账号 `gwacct_<编号>`、使用记录 `gateway:<编号>` 都由它派生。
 *
 * 编号只增不减，不像槽位那样补空位：运营端在建草稿时就把编号交给 Worker 的授权会话，
 * Worker 在控制面写入账号行之前就按它保存凭据（OAuth 换码、导入），收尾失败会留下孤立的
 * 运行账号，复用编号会撞上旧凭据。因此运营端建草稿即用 `reserveGatewayAccountId` 记高水位；
 * 草稿只在本进程内存里，供应商建号也靠这个高水位避开进行中的草稿。放弃的草稿留下空号。
 * 早期账号沿用 `account_<uuid>`，不改名（编号已写入 Worker 存储与历史使用记录）。
 */
import { gatewayAccountIds, raiseSettingCounter, settingValue } from './repos/account-ids-repo.mjs'
export const GATEWAY_ACCOUNT_ID_PREFIX = 'gw-'
const SEQ_KEY = 'gateway_account_id_seq'

export function gatewayAccountNumber(id) {
  const match = /^gw-(\d+)$/.exec(String(id || ''))
  return match ? Number(match[1]) : 0
}

/** 下一个编号：已建账号与已记高水位两者的最大值 + 1。 */
export function nextGatewayAccountId(db) {
  const seq = Number(settingValue(db, SEQ_KEY)?.value || 0)
  const used = gatewayAccountIds(db).map((row) => gatewayAccountNumber(row.id))
  const n = Math.max(seq, ...used) + 1
  return GATEWAY_ACCOUNT_ID_PREFIX + String(n).padStart(2, '0')
}

/** 编号已分配出去（运营端草稿）：记入高水位，此后不再分配。 */
export function reserveGatewayAccountId(db, id) {
  const n = gatewayAccountNumber(id)
  if (!n) return
  raiseSettingCounter(db, SEQ_KEY, String(n), new Date().toISOString())
}

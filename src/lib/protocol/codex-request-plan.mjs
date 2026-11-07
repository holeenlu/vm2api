/**
 * Codex 请求计划（审计阶段 2 W12）：协议转换之后、VM 与 Gateway Worker 分流之前一次算出两条路径共用的决定，
 * 消除两条路径各算一遍造成的漂移：
 *   - 预压缩：上下文接近模型窗口时裁剪输入（此前只有 VM 路径做，Gateway 原样发出）；
 *   - 白名单所用模型：分组模型白名单按客户端请求的模型名判断（入口如此），排队与发送前的复核用同一个名字
 *     （此前 VM 复核按映射后的上游模型名，模型映射时会误拒）；
 *   - 分组 Fast 三态：VM 路径按与 Worker `applyFastPolicy`（worker/internal/codexgateway/background.go）同一规则改写
 *     出站档位（此前只在 Gateway 生效）；Gateway 仍由 Worker 按账号套餐目录执行；
 *   - 准入核价所用档位：分组关闭 Fast 时 priority/fast 会被降为 default，按降档后的档位核价（此前按改写前档位，
 *     会以 service_tier_unpriced 误拒）。
 */
import { resolvePrice } from '../admin/price-catalog.mjs'
import { compactCodexInput } from './codex-context-budget.mjs'

export const CODEX_FAST_MODES = Object.freeze(['default', 'enabled', 'disabled'])

/**
 * 分组 Fast 三态改写出站档位，与 Worker applyFastPolicy 同口径：
 * disabled 把 priority/fast 降为 default；enabled 在模型支持 priority 时把未指定（缺省或 null）与 default 升为 priority；
 * 其余（default 模式、flex、空串等）原样。
 */
export function applyCodexFastPolicy(body, mode, supportsPriority) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const raw = body.service_tier
  if (raw != null && typeof raw !== 'string') return body
  const tier = raw == null ? null : raw.trim().toLowerCase()
  if (mode === 'disabled' && (tier === 'priority' || tier === 'fast')) return { ...body, service_tier: 'default' }
  if (mode === 'enabled' && supportsPriority && (tier === null || tier === 'default'))
    return { ...body, service_tier: 'priority' }
  return body
}

/** VM 路径判断模型是否支持 priority：价目表收录了 priority 档位（Gateway 由 Worker 按账号套餐目录判断）。 */
export function priorityPriced(model) {
  return !!resolvePrice(model)?.modes?.priority
}

/** 准入核价用的请求体：分组关闭 Fast 时按降档后的档位核价；其他模式下改写只会升到已定价的档位，原样核价。 */
export function admissionBody(body, fastMode) {
  return fastMode === 'disabled' ? applyCodexFastPolicy(body, 'disabled', false) : body
}

/** 分流前的请求计划。body 为转换后的 Responses 请求体，clientModel 为客户端请求的模型名。 */
export function planCodexRequest({ body, clientModel = null, fastMode = null } = {}) {
  const compaction = compactCodexInput(body)
  return {
    body: compaction ? compaction.body : body,
    compaction: compaction?.info || null,
    allowlistModel: clientModel || body?.model || null,
    fastMode: CODEX_FAST_MODES.includes(fastMode) ? fastMode : 'default',
  }
}

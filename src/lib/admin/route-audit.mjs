/**
 * 管理写操作的路由级审计（docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 4.3，R3）。
 *
 * 路由表中 audit='route' 的路由（写入配置、凭据或运行状态，但处理器没有写完整审计），在响应成功（状态码 < 400）
 * 结束后写一条 operation_audit：操作者、`route:<方法> <路径模式>`、实际路径，以及请求体的顶层字段名。
 * 不记字段值：请求体里可能有凭据、密码、代理密码。处理器自己写了完整审计的路由标为 audit='handler'，不重复记录。
 *
 * 终端票据、凭据明文回显这类高危操作由处理器调用 auditSensitiveAction 写审计（audit='handler'），
 * 记录操作者、来源 IP、目标与签发时间；不记票据、凭据或其他明文。
 */
import { getDb } from '../db/database.mjs'
import { clientIp } from '../pool/sticky-router.mjs'
import { audit } from './relay-common.mjs'
import { matchRoute } from './route-table.mjs'

const BODY_FIELDS = Symbol('route-audit-body-fields')
const MAX_FIELDS = 50
const WARN_INTERVAL_MS = 10 * 60_000
let warnedAt = 0

/** 记下请求体的顶层字段名（readBody 解析后调用）。 */
export function rememberBodyFields(req, body) {
  if (!req || typeof req !== 'object' || !body || typeof body !== 'object' || Array.isArray(body)) return
  req[BODY_FIELDS] = Object.keys(body).sort().slice(0, MAX_FIELDS)
}

export function routeAuditActor(req) {
  if (req?.apiKeyKind === 'master') return 'master'
  return String(req?.panelUserId || req?.panelUser || 'unknown')
}

/**
 * 高危操作的处理器审计：操作者、来源 IP、目标与时间。先写审计再把票据或明文交给调用方：写入失败时抛出，
 * 调用方不返回结果（宁可拒绝，也不留下无记录的高危操作）。details 只放非敏感上下文。
 */
export async function auditSensitiveAction(
  req,
  action,
  target,
  details = {},
  { db = () => getDb(), now = Date.now } = {},
) {
  await audit(db(), routeAuditActor(req), action, String(target), null, {
    // ip 取 X-Forwarded-For 首段（与登录限速一致），peer 是 TCP 对端，经反向代理时为代理地址
    ip: clientIp(req) || null,
    peer: String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null,
    at: new Date(now()).toISOString(),
    ...details,
  })
}

/** 返回这次请求要写的审计记录；不需要审计时返回 null。 */
export function routeAuditEntry(req, path, statusCode) {
  const route = matchRoute(req?.method, path)
  if (route?.audit !== 'route' || !(statusCode < 400)) return null
  return {
    actor: routeAuditActor(req),
    action: `route:${route.method} ${route.path}`,
    target: path,
    after: { status: statusCode, fields: req?.[BODY_FIELDS] || [] },
  }
}

/** 响应结束后按路由表写审计；写入失败只告警（限频），不影响已发出的响应。 */
export function watchRouteAudit(req, res, path, { db = () => getDb(), log = console, now = Date.now } = {}) {
  if (typeof res?.once !== 'function' || matchRoute(req?.method, path)?.audit !== 'route') return
  res.once('finish', () => {
    const entry = routeAuditEntry(req, path, res.statusCode)
    if (!entry) return
    const warn = (error) => {
      if (now() - warnedAt < WARN_INTERVAL_MS) return
      warnedAt = now()
      log.warn?.(`route audit: ${entry.action} not recorded: ${error?.message || error}`)
    }
    // 监听器不能等待：审计异步写入（R6 B6b），失败（同步抛出或 Promise 拒绝）只告警
    try {
      audit(db(), entry.actor, entry.action, entry.target, null, entry.after).catch(warn)
    } catch (error) {
      warn(error)
    }
  })
}

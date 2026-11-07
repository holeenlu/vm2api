/**
 * routing.json 调度段的描述校验（审计阶段 2 W11，配置 schema 化）。
 * 字段、类型、范围与枚举定义在 src/shared/executor-schema/routing-pool.json：
 *   - 保存（persistRoutingPatch、PUT /api/panel/routing）前校验 pool、sticky、quota、concurrency、failover，
 *     未知键与非法值抛 RoutingConfigError（TypeError，400 invalid_routing_config，errors 列出字段与原因）；
 *   - 加载（loadRoutingConfig）时修复：超出范围的数值截断，其他非法值回到 default（没有 default 的字段删除，
 *     由使用方取内置默认），未知键删除；同一问题每个进程只告警一次，不阻断启动。
 * compatibility 等其他段由各自的规范化与校验函数负责，不在本描述内。
 */
import fs from 'node:fs'
import { checkValue, validateAgainstSchema } from '../executor/settings-schema.mjs'

export const ROUTING_POOL_SCHEMA = Object.freeze(
  JSON.parse(fs.readFileSync(new URL('../../shared/executor-schema/routing-pool.json', import.meta.url), 'utf8')),
)

const SECTIONS = Object.freeze([...ROUTING_POOL_SCHEMA.sections])
const FIELDS = new Map(ROUTING_POOL_SCHEMA.fields.map((field) => [field.key, field]))
// 嵌套对象（如 quota.weekly_split）：字段路径的中间层
const BRANCHES = new Set(
  ROUTING_POOL_SCHEMA.fields.flatMap((field) => {
    const parts = field.key.split('.')
    return parts.slice(1, -1).map((_, index) => parts.slice(0, index + 2).join('.'))
  }),
)

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export class RoutingConfigError extends TypeError {
  constructor(errors) {
    super(`Invalid routing config: ${errors.map((item) => `${item.field}: ${item.reason}`).join('; ')}`)
    this.code = 'invalid_routing_config'
    this.status = 400
    this.errors = errors
  }
}

/** 保存前校验调度段补丁：未出现的段不检查；非法即抛 RoutingConfigError。 */
export function validateRoutingPoolPatch(body) {
  if (!isPlainObject(body)) return
  const errors = []
  const patch = {}
  for (const section of SECTIONS) {
    const value = body[section]
    if (value === undefined || value === null) continue
    if (!isPlainObject(value)) errors.push({ field: section, reason: 'must be an object' })
    else patch[section] = value
  }
  if (!errors.length) errors.push(...validateAgainstSchema(ROUTING_POOL_SCHEMA, patch))
  if (errors.length) throw new RoutingConfigError(errors)
}

const warned = new Set()

function warnOnce(field, reason, action) {
  const key = `${field}\u0000${reason}\u0000${action}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(JSON.stringify({ event: 'routing_config_invalid', field, reason, action }))
}

function repair(field, value) {
  if (field.type === 'integer' || field.type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
    if (Number.isFinite(n)) {
      let next = field.type === 'integer' ? Math.round(n) : n
      if (field.min != null) next = Math.max(field.min, next)
      if (field.max != null) next = Math.min(field.max, next)
      return { value: next, action: 'clamped' }
    }
  }
  if (Object.hasOwn(field, 'default')) return { value: field.default, action: 'default' }
  return { remove: true, action: 'removed' }
}

function sanitizeObject(prefix, value, warn) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const path = `${prefix}.${key}`
    const field = FIELDS.get(path)
    if (field) {
      const reason = checkValue(field, item)
      if (!reason) {
        out[key] = item
        continue
      }
      const fixed = repair(field, item)
      warn(path, reason, fixed.action)
      if (!fixed.remove) out[key] = fixed.value
    } else if (BRANCHES.has(path) && isPlainObject(item)) {
      out[key] = sanitizeObject(path, item, warn)
    } else {
      warn(path, BRANCHES.has(path) ? 'must be an object' : 'unknown setting', 'removed')
    }
  }
  return out
}

/** 加载时修复调度段（原地修改并返回 doc）；warn 默认按问题去重写一条 routing_config_invalid。 */
export function sanitizeRoutingPoolSections(doc, { warn = warnOnce } = {}) {
  if (!isPlainObject(doc)) return doc
  for (const section of SECTIONS) {
    const value = doc[section]
    if (value === undefined) continue
    if (!isPlainObject(value)) {
      warn(section, 'must be an object', 'removed')
      delete doc[section]
      continue
    }
    doc[section] = sanitizeObject(section, value, warn)
  }
  return doc
}

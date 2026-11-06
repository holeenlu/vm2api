import { relayError } from './relay-common.mjs'
import { validateIpRules } from './key-ip-rules.mjs'

const NUMERIC = {
  max_concurrency: 128,
  quota_requests: 1e9,
  rpm: 1e6,
  quota_usd: null,
  rate_limit_5h: null,
  rate_limit_1d: null,
  rate_limit_7d: null,
}
const FIELDS = new Set([...Object.keys(NUMERIC), 'group_id', 'status', 'expires_at', 'ip_whitelist', 'ip_blacklist'])

export function validateBulkKeyEdit(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['ids', 'patch'].includes(k))
  )
    throw relayError('invalid_bulk_edit', '批量编辑请求无效')
  const { ids, patch } = body
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 500 ||
    ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)
  )
    throw relayError('invalid_key_ids', '每次请选择 1–500 个 API 密钥')
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    !Object.keys(patch).length ||
    Object.keys(patch).some((key) => !FIELDS.has(key))
  )
    throw relayError('invalid_bulk_patch', '请选择支持批量编辑的字段')
  for (const [field, max] of Object.entries(NUMERIC)) {
    if (!Object.hasOwn(patch, field)) continue
    const value = patch[field]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (max !== null ? !Number.isInteger(value) || value > max : !Number.isSafeInteger(Math.round(value * 1e6)))
    )
      throw relayError('invalid_' + field, field + ' 必须是允许范围内的非负数')
  }
  if (
    Object.hasOwn(patch, 'group_id') &&
    patch.group_id !== null &&
    (!Number.isSafeInteger(patch.group_id) || patch.group_id <= 0)
  )
    throw relayError('invalid_group_id', '请选择服务分组')
  if (Object.hasOwn(patch, 'status') && !['active', 'disabled'].includes(patch.status))
    throw relayError('invalid_status', '不支持的密钥状态')
  if (
    Object.hasOwn(patch, 'expires_at') &&
    patch.expires_at !== null &&
    (typeof patch.expires_at !== 'string' ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(patch.expires_at) ||
      !Number.isFinite(Date.parse(patch.expires_at)))
  )
    throw relayError('invalid_expires_at', '有效期必须是包含时区的日期或 null')
  for (const field of ['ip_whitelist', 'ip_blacklist'])
    if (Object.hasOwn(patch, field)) {
      if (!Array.isArray(patch[field])) throw relayError('invalid_' + field, field + ' 必须是数组')
      validateIpRules(patch[field])
    }
  return { ids: [...new Set(ids)], patch }
}

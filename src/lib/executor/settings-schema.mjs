/**
 * 设置描述（统一控制面重构 P4.4，设计 5.2、第 10 节）：Codex 本地设置的字段、类型、范围、分组、
 * 条件显示与文案 key 定义在 src/shared/executor-schema/codex-settings.json，三处共用：
 *   - 控制面保存时按描述在服务端校验（本文件），不能只靠前端；
 *   - 面板按描述渲染表单（P6）；
 *   - Worker 内嵌同一份描述，经 GET /internal/v1/schema/settings 提供，并在能力描述中报告版本
 *     （Go 测试保证内嵌副本与这里逐字节一致；版本不一致时控制面告警）。
 */
import fs from 'node:fs'

const read = (name) =>
  JSON.parse(fs.readFileSync(new URL(`../../shared/executor-schema/${name}`, import.meta.url), 'utf8'))

export const CODEX_SETTINGS_SCHEMA = Object.freeze(read('codex-settings.json'))

export class SchemaValidationError extends Error {
  constructor(errors, code = 'invalid_executor_settings') {
    super(errors.map((item) => `${item.field}: ${item.reason}`).join('; '))
    this.code = code
    this.status = 400
    this.errors = errors
  }
}

function fieldsOf(schema) {
  return new Map(schema.fields.map((field) => [field.key, field]))
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

// 把补丁按描述里的字段路径展开；对象只在不是叶子字段时继续向下
function flatten(fields, value, prefix = '', out = []) {
  for (const [key, item] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (!fields.has(path) && isPlainObject(item)) flatten(fields, item, path, out)
    else out.push([path, item])
  }
  return out
}

export function getPath(value, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), value)
}

/** 单个值是否符合字段描述：返回原因文字，通过返回 null（routing-schema.mjs 加载修复时复用）。 */
export function checkValue(field, value) {
  if (value === null) return field.nullable ? null : 'must not be null'
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean'
    case 'enum':
      return field.values.includes(value) ? null : `must be one of ${field.values.join(', ')}`
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      if (field.type === 'integer' && !Number.isInteger(value)) return 'must be an integer'
      if (field.min != null && value < field.min) return `must be at least ${field.min}`
      if (field.max != null && value > field.max) return `must be at most ${field.max}`
      if (field.step && Math.abs(Math.round(value / field.step) * field.step - value) > 1e-9)
        return `must be a multiple of ${field.step}`
      return null
    }
    case 'string':
      if (typeof value !== 'string') return 'must be a string'
      return field.max_length != null && value.length > field.max_length
        ? `must be at most ${field.max_length} characters`
        : null
    case 'string_list': {
      if (!Array.isArray(value)) return 'must be a list'
      if (field.max_items != null && value.length > field.max_items) return `must have at most ${field.max_items} items`
      const pattern = field.pattern ? new RegExp(field.pattern) : null
      for (const item of value) {
        if (typeof item !== 'string' || !item || item !== item.trim()) return 'items must be non-empty trimmed strings'
        if (field.max_length != null && item.length > field.max_length)
          return `items must be at most ${field.max_length} characters`
        if (pattern && !pattern.test(item)) return `items must match ${field.pattern}`
      }
      if (field.unique && new Set(value).size !== value.length) return 'items must be unique'
      return null
    }
    default:
      return `unsupported field type ${field.type}`
  }
}

function matches(rule, values) {
  if (!rule) return true
  const actual = getPath(values, rule.key)
  if ('equals' in rule) return actual === rule.equals
  return true
}

/**
 * 按描述校验补丁：未知字段、类型、范围、条件约束（required_when）。
 * resulting 为合并补丁后的完整值（用于跨字段约束；不提供时只做逐字段校验）。返回错误列表（空表示通过）。
 */
export function validateAgainstSchema(schema, patch, resulting = null) {
  const fields = fieldsOf(schema)
  const errors = []
  if (!isPlainObject(patch)) return [{ field: '*', reason: 'must be an object' }]
  for (const [path, value] of flatten(fields, patch)) {
    const field = fields.get(path)
    if (!field) {
      errors.push({ field: path, reason: 'unknown setting' })
      continue
    }
    const reason = checkValue(field, value)
    if (reason) errors.push({ field: path, reason })
  }
  if (errors.length || !resulting) return errors
  for (const field of schema.fields) {
    const value = getPath(resulting, field.key)
    if (
      field.required_when &&
      matches(field.required_when, resulting) &&
      (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length))
    )
      errors.push({ field: field.key, reason: `is required when ${field.required_when.key} is set` })
  }
  return errors
}

/** Codex 本地设置补丁的服务端校验（settings-store.mjs 保存前调用）；非法即抛 SchemaValidationError。 */
export function validateCodexSettingsPatch(patch, resulting = null) {
  const errors = validateAgainstSchema(CODEX_SETTINGS_SCHEMA, patch, resulting)
  if (errors.length) throw new SchemaValidationError(errors)
}

/** 控制面使用的描述版本（与 Worker 能力描述中的版本比对）。 */
export function schemaVersions() {
  return { settings: CODEX_SETTINGS_SCHEMA.version }
}

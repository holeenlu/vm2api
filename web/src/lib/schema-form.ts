/**
 * 设置描述（executor settings schema，src/shared/executor-schema/*.json）的通用表单逻辑（统一控制面重构 P6.1）。
 * 与服务端校验（src/lib/executor/settings-schema.mjs）同一套规则；前端校验只为即时提示，保存时仍以服务端为准。
 */

export type SchemaCondition = {
  key: string
  equals?: unknown
  not_equals?: unknown
}

export type SchemaField = {
  key: string
  group: string
  type:
    | 'boolean'
    | 'enum'
    | 'integer'
    | 'number'
    | 'string'
    | 'string_list'
    | 'group_ref'
  label: string
  help?: string
  placeholder?: string
  invalid?: string
  default?: unknown
  values?: (string | number)[]
  option_label?: string
  help_by_value?: string
  min?: number
  max?: number
  step?: number
  max_length?: number
  max_items?: number
  pattern?: string
  no_wildcard?: boolean
  unique?: boolean
  nullable?: boolean
  allow_zero?: boolean
  less_than?: string
  requires?: string
  required_when?: SchemaCondition
  visible_when?: SchemaCondition
  widget?: string
  control_plane_only?: boolean
}

export type SchemaGroup = {
  id: string
  label: string
  help?: string
  visible_when?: SchemaCondition
}

export type SettingsSchema = {
  version: number
  scope: string
  i18n_namespace?: string
  groups: SchemaGroup[]
  fields: SchemaField[]
}

export type SchemaValues = Record<string, unknown>

export type FieldError = { field: string; reason: string }

export function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value
    )
}

/** 不可变地设置嵌套字段，返回新对象。 */
export function setPath(
  value: SchemaValues,
  path: string,
  next: unknown
): SchemaValues {
  const [head, ...rest] = path.split('.')
  if (!rest.length) return { ...value, [head]: next }
  const child = value[head]
  return {
    ...value,
    [head]: setPath(
      child && typeof child === 'object' && !Array.isArray(child)
        ? (child as SchemaValues)
        : {},
      rest.join('.'),
      next
    ),
  }
}

export function conditionHolds(
  condition: SchemaCondition | undefined,
  values: SchemaValues
): boolean {
  if (!condition) return true
  const actual = getPath(values, condition.key)
  if ('equals' in condition) return actual === condition.equals
  if ('not_equals' in condition) return actual !== condition.not_equals
  return true
}

/** 文本框里的列表：按逗号、空白分隔，去掉空项。 */
export function parseList(text: string): string[] {
  return text
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 单个字段的即时校验，返回失败原因的英文短语（显示时优先用字段的 invalid 文案）。 */
export function fieldError(
  field: SchemaField,
  value: unknown,
  values: SchemaValues
): string | null {
  const empty =
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  if (
    empty &&
    field.required_when &&
    conditionHolds(field.required_when, values)
  )
    return 'required'
  if (value === null || value === undefined || value === '') {
    // 不可空的数字清空（''）也算缺失（R4 审查 P2-5）
    return !field.nullable &&
      ['integer', 'number', 'group_ref', 'enum', 'boolean'].includes(field.type)
      ? 'required'
      : null
  }
  switch (field.type) {
    case 'integer':
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) return 'number'
      if (field.type === 'integer' && !Number.isInteger(n)) return 'integer'
      if (field.min != null && n < field.min) return 'min'
      if (field.max != null && n > field.max) return 'max'
      if (
        field.step &&
        Math.abs(Math.round(n / field.step) * field.step - n) > 1e-9
      )
        return 'step'
      if (field.less_than) {
        const bound = Number(getPath(values, field.less_than))
        if (Number.isFinite(bound) && !(n < bound)) return 'less_than'
      }
      return null
    }
    case 'string':
      return field.max_length != null && String(value).length > field.max_length
        ? 'max_length'
        : null
    case 'string_list': {
      const items = Array.isArray(value) ? value : []
      if (field.max_items != null && items.length > field.max_items)
        return 'max_items'
      const pattern = field.pattern ? new RegExp(field.pattern) : null
      for (const item of items) {
        if (field.max_length != null && String(item).length > field.max_length)
          return 'max_length'
        if (field.no_wildcard && String(item).includes('*')) return 'wildcard'
        if (pattern && !pattern.test(String(item))) return 'pattern'
      }
      if (field.unique && new Set(items).size !== items.length) return 'unique'
      return null
    }
    case 'boolean':
      if (
        field.requires &&
        value === true &&
        getPath(values, field.requires) !== true
      )
        return 'requires'
      return null
    default:
      return null
  }
}

/** 所有可见字段的即时校验结果。 */
export function schemaErrors(
  schema: SettingsSchema,
  values: SchemaValues
): FieldError[] {
  const errors: FieldError[] = []
  for (const field of schema.fields) {
    const group = schema.groups.find((item) => item.id === field.group)
    if (!conditionHolds(group?.visible_when, values)) continue
    if (!conditionHolds(field.visible_when, values)) continue
    const reason = fieldError(field, getPath(values, field.key), values)
    if (reason) errors.push({ field: field.key, reason })
  }
  return errors
}

/**
 * 把表单这次的修改并入草稿：只取 next 与当前显示值 shown 不同的字段写进 draft。
 * 显示值可能经过联动收敛（例如隐藏字段被压到上限以内）；收敛结果不写回草稿，
 * 每次都从草稿和已保存的值重新计算，中途输入的过渡值不会把隐藏字段永久改掉。
 */
export function applyFieldChanges(
  schema: SettingsSchema,
  draft: SchemaValues,
  shown: SchemaValues,
  next: SchemaValues
): SchemaValues {
  let out = draft
  for (const field of schema.fields) {
    const value = getPath(next, field.key)
    if (JSON.stringify(value) !== JSON.stringify(getPath(shown, field.key)))
      out = setPath(out, field.key, value)
  }
  return out
}

/** 按描述只取出描述里定义过的字段（保存时只提交这些）。 */
export function pickSchemaValues(
  schema: SettingsSchema,
  values: SchemaValues
): SchemaValues {
  let out: SchemaValues = {}
  for (const field of schema.fields) {
    const value = getPath(values, field.key)
    if (value !== undefined) out = setPath(out, field.key, value)
  }
  return out
}

/** 文案 key 里的 {value} 占位符。 */
export function labelFor(template: string, value: unknown): string {
  return template.split('{value}').join(String(value))
}

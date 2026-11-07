import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  conditionHolds,
  fieldError,
  getPath,
  labelFor,
  parseList,
  setPath,
  type SchemaField,
  type SchemaValues,
  type SettingsSchema,
} from '@/lib/schema-form'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

/** 宿主为个别字段提供的专用控件（例如按目录勾选的模型、分组选择）。 */
export type SchemaWidget = (props: {
  field: SchemaField
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}) => React.ReactNode

/**
 * 按设置描述渲染表单（统一控制面重构 P6.1，设计第 11 节）：分组、条件显示、类型对应的控件、即时校验与文案 key。
 * 文案 key 在描述的 i18n_namespace 下查找（与手写组件共用同一套文案）。保存与服务端校验由宿主负责。
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  disabled,
  widgets = {},
  groups,
  serverErrors = [],
  renderGroup,
}: {
  schema: SettingsSchema
  value: SchemaValues
  onChange: (next: SchemaValues) => void
  disabled?: boolean
  widgets?: Record<string, SchemaWidget>
  /** 只渲染这些分组（缺省全部） */
  groups?: string[]
  serverErrors?: { field: string; reason: string }[]
  /** 分组外框（缺省为带标题的区块）；宿主可换成自己的卡片样式 */
  renderGroup?: (props: {
    id: string
    title: string
    help?: string
    children: React.ReactNode
  }) => React.ReactNode
}) {
  const { t: translate } = useTranslation(schema.i18n_namespace || 'common')
  const t: Translate = (key, options) =>
    String(translate(key, options as never))
  const visibleGroups = schema.groups.filter(
    (group) =>
      (!groups || groups.includes(group.id)) &&
      conditionHolds(group.visible_when, value)
  )
  return (
    <>
      {visibleGroups.map((group) => {
        const fields = schema.fields.filter(
          (field) =>
            field.group === group.id &&
            conditionHolds(field.visible_when, value)
        )
        if (!fields.length) return null
        const body = (
          <div className='divide-y'>
            {fields.map((field) => (
              <SchemaFieldRow
                key={field.key}
                field={field}
                values={value}
                disabled={disabled}
                widget={
                  field.widget
                    ? widgets[field.widget] || widgets[field.key]
                    : widgets[field.key]
                }
                serverError={
                  serverErrors.find((item) => item.field === field.key)?.reason
                }
                t={t}
                onChange={(next) => onChange(setPath(value, field.key, next))}
              />
            ))}
          </div>
        )
        const title = t(group.label)
        const help = group.help ? t(group.help) : undefined
        return renderGroup ? (
          <div key={group.id}>
            {renderGroup({ id: group.id, title, help, children: body })}
          </div>
        ) : (
          <section
            key={group.id}
            className='space-y-2'
            data-schema-group={group.id}
          >
            <div>
              <h4 className='text-sm font-medium'>{title}</h4>
              {help ? (
                <p className='text-xs text-muted-foreground'>{help}</p>
              ) : null}
            </div>
            {body}
          </section>
        )
      })}
    </>
  )
}

type Translate = (key: string, options?: Record<string, unknown>) => string

function SchemaFieldRow({
  field,
  values,
  disabled,
  widget,
  serverError,
  onChange,
  t,
}: {
  field: SchemaField
  values: SchemaValues
  disabled?: boolean
  widget?: SchemaWidget
  serverError?: string
  onChange: (value: unknown) => void
  t: Translate
}) {
  const value = getPath(values, field.key)
  const error = fieldError(field, value, values) || serverError
  const label = t(field.label, { defaultValue: field.label })
  const help = field.help_by_value
    ? t(labelFor(field.help_by_value, value), { defaultValue: '' })
    : field.help
      ? t(field.help)
      : undefined
  const errorText = error
    ? field.invalid
      ? t(field.invalid)
      : t('common:schemaFieldInvalid', { reason: error, defaultValue: error })
    : null
  const describedBy = `schema-desc-${field.key.replace(/\W/g, '-')}`
  const desc = (
    <span id={describedBy}>
      {help}
      {errorText ? (
        <span
          className='block text-destructive'
          role='alert'
          data-schema-error={field.key}
        >
          {errorText}
        </span>
      ) : null}
    </span>
  )
  return (
    // 宿主提供的专用控件（模型勾选、分组下拉等）通常较宽：标签与说明在上、控件占满整行，避免挤出对话框
    widget ? (
      <div
        className='space-y-2 py-3 first:pt-0 last:pb-0'
        data-schema-widget={field.key}
      >
        <div className='space-y-0.5'>
          <p className='text-sm font-medium'>{label}</p>
          {help || errorText ? (
            <p className='text-xs text-muted-foreground'>{desc}</p>
          ) : null}
        </div>
        <div className='min-w-0'>
          {widget({ field, value, disabled, onChange })}
        </div>
      </div>
    ) : (
      <SettingRow label={label} desc={help || errorText ? desc : undefined}>
        <SchemaControl
          field={field}
          value={value}
          disabled={disabled}
          onChange={onChange}
          label={label}
          invalid={!!error}
          describedBy={help || errorText ? describedBy : undefined}
          t={t}
        />
      </SettingRow>
    )
  )
}

function SchemaControl({
  field,
  value,
  disabled,
  onChange,
  label,
  invalid,
  describedBy,
  t,
}: {
  field: SchemaField
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
  label: string
  invalid: boolean
  describedBy?: string
  t: Translate
}) {
  const [listText, setListText] = useState<string | null>(null)
  const inputClass = cn('w-40', invalid && 'border-destructive')
  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
          aria-label={label}
          aria-describedby={describedBy}
          data-schema-field={field.key}
        />
      )
    case 'enum':
      return (
        <div
          role='radiogroup'
          aria-label={label}
          aria-describedby={describedBy}
          onKeyDown={(event) => {
            // 方向键在选项间移动并选中（单选组的键盘约定）
            const options = field.values || []
            const index = options.indexOf(value as string | number)
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0
            if (!step || disabled || !options.length) return
            event.preventDefault()
            const next =
              options[(index + step + options.length) % options.length]
            onChange(next)
            const buttons = event.currentTarget.querySelectorAll('button')
            buttons[options.indexOf(next)]?.focus()
          }}
          className='flex flex-wrap gap-1.5'
          data-schema-field={field.key}
        >
          {(field.values || []).map((option) => {
            const on = option === value
            return (
              <button
                key={String(option)}
                type='button'
                role='radio'
                aria-checked={on}
                tabIndex={
                  on || (value === undefined && option === field.values?.[0])
                    ? 0
                    : -1
                }
                disabled={disabled}
                onClick={() => onChange(option)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition-colors',
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                {field.option_label
                  ? t(labelFor(field.option_label, option))
                  : String(option)}
              </button>
            )
          })}
        </div>
      )
    case 'integer':
    case 'number':
      return (
        <Input
          type='number'
          inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
          className={inputClass}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.type === 'integer' ? 1 : 'any')}
          value={value === null || value === undefined ? '' : String(value)}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-schema-field={field.key}
          onChange={(event) => {
            const text = event.target.value
            if (text === '') onChange(field.nullable ? null : '')
            else onChange(Number(text))
          }}
        />
      )
    case 'string_list':
      return (
        <Input
          className={cn('w-72', invalid && 'border-destructive')}
          value={listText ?? (Array.isArray(value) ? value.join(', ') : '')}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-schema-field={field.key}
          onChange={(event) => {
            setListText(event.target.value)
            onChange(parseList(event.target.value))
          }}
          onBlur={() => setListText(null)}
        />
      )
    default:
      return (
        <Input
          className={inputClass}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.max_length}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-schema-field={field.key}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

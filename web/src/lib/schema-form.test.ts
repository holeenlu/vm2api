import { describe, expect, it } from 'vitest'
import settingsSchema from '../../../src/shared/executor-schema/codex-settings.json'
import {
  conditionHolds,
  fieldError,
  labelFor,
  parseList,
  pickSchemaValues,
  schemaErrors,
  setPath,
  type SettingsSchema,
} from './schema-form'

const schema = settingsSchema as SettingsSchema
const defaults = () => {
  let out = {}
  for (const field of schema.fields)
    out = setPath(out, field.key, field.default)
  return out
}

describe('schema-form', () => {
  it('builds nested values immutably and only keeps schema fields', () => {
    const base = { scheduling: { smart_weights: { load: 1 } } }
    const next = setPath(base, 'scheduling.smart_weights.quota', 2)
    expect(base.scheduling.smart_weights).toEqual({ load: 1 })
    expect(next).toEqual({
      scheduling: { smart_weights: { load: 1, quota: 2 } },
    })
    expect(pickSchemaValues(schema, { ...next, unknown: 1 })).toEqual(next)
  })

  it('evaluates visibility and the same rules as the server', () => {
    const values = defaults()
    expect(schemaErrors(schema, values)).toEqual([])
    expect(
      conditionHolds({ key: 'scheduling.strategy', equals: 'smart' }, values)
    ).toBe(true)
    const times = schema.fields.find((field) => field.key === 'warmup.times')!
    expect(fieldError(times, ['25:00'], values)).toBe('pattern')
    // 隐藏字段不报错：预热时刻只在开启预热时显示
    expect(
      schemaErrors(
        schema,
        setPath(setPath(values, 'warmup.enabled', false), 'warmup.times', [
          '25:00',
        ])
      )
    ).toEqual([])
  })

  it('parses list input and fills option labels', () => {
    expect(parseList('08:00, 09:30  12:00，')).toEqual([
      '08:00',
      '09:30',
      '12:00',
    ])
    expect(labelFor('codexScheduling.{value}', 'smart')).toBe(
      'codexScheduling.smart'
    )
  })
})

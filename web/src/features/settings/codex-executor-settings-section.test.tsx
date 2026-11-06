import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import {
  applyFieldChanges,
  getPath,
  setPath,
  type SchemaValues,
  type SettingsSchema,
} from '@/lib/schema-form'
import { SchemaForm } from '@/components/schema-form'
import settingsSchema from '../../../../src/shared/executor-schema/codex-settings.json'
import { linkCodexSettings } from '../../../../src/shared/executor-schema/link-codex-settings.mjs'
import {
  hiddenErrors,
  settingsPayload,
} from './codex-executor-settings-section'

const schema = settingsSchema as SettingsSchema
const defaults = () => {
  let out = {}
  for (const field of schema.fields)
    out = setPath(out, field.key, field.default)
  return out
}

describe('Codex execution settings section', () => {
  it('saves only schema fields with the edited revision', () => {
    const payload = settingsPayload(schema, { ...defaults(), stray: 1 }, 7)
    expect(payload.expected_revision).toBe(7)
    expect(payload.values).not.toHaveProperty('stray')
  })

  it('lists server errors that land on hidden fields', () => {
    const values = setPath(defaults(), 'bps_images.policy', 'auto_compact')
    expect(
      hiddenErrors(schema, values, [
        { field: 'bps_images.warning_remaining', reason: 'too big' },
        { field: 'bps_images.max_images', reason: 'visible' },
      ]).map((item) => item.field)
    ).toEqual(['bps_images.warning_remaining'])
  })

  it('links hidden dependents instead of leaving an unsaveable draft', () => {
    const before = setPath(defaults(), 'bps_defaults.auto_recover_on_403', true)
    const next = linkCodexSettings(
      setPath(before, 'bps_defaults.auto_disable_on_403', false),
      before
    )
    expect(
      (next.bps_defaults as { auto_recover_on_403: boolean })
        .auto_recover_on_403
    ).toBe(false)
  })

  it('a transient value while typing does not permanently clamp hidden fields', () => {
    const saved = defaults() as SchemaValues
    const view = (draft: SchemaValues) =>
      linkCodexSettings(draft, saved) as SchemaValues
    const type = (draft: SchemaValues, value: number) => {
      const shown = view(draft)
      return applyFieldChanges(
        schema,
        draft,
        shown,
        setPath(shown, 'bps_images.max_images', value)
      )
    }
    // 20 → 1（输入 15 的中途）：显示值收敛到 0
    const typing = type(saved, 1)
    expect(getPath(view(typing), 'bps_images.warning_remaining')).toBe(0)
    // → 15：恢复已保存的提醒余量与压缩预留
    const done = view(type(typing, 15))
    expect(getPath(done, 'bps_images.warning_remaining')).toBe(
      getPath(saved, 'bps_images.warning_remaining')
    )
    expect(getPath(done, 'bps_images.compact_reserve')).toBe(
      getPath(saved, 'bps_images.compact_reserve')
    )
  })

  it('renders groups, hides conditional fields and wires descriptions', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <SchemaForm schema={schema} value={defaults()} onChange={() => {}} />
      </I18nextProvider>
    )
    expect(html).toContain('data-schema-group="scheduling"')
    expect(html).toContain('data-schema-field="warmup.enabled"')
    expect(html).not.toContain('data-schema-field="warmup.times"')
    expect(html).toMatch(/role="radiogroup"[^>]*aria-describedby=/)
    expect(html).toContain(i18n.t('settings:codexScheduling.title'))
  })
})

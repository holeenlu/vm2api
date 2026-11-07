import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { setPath, type SettingsSchema } from '@/lib/schema-form'
import { SchemaForm } from '@/components/schema-form'
import settingsSchema from '../../../../src/shared/executor-schema/codex-settings.json'
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
    const values = setPath(defaults(), 'warmup.enabled', false)
    expect(
      hiddenErrors(schema, values, [
        { field: 'warmup.times', reason: 'hidden' },
        { field: 'warmup.enabled', reason: 'visible' },
      ]).map((item) => item.field)
    ).toEqual(['warmup.times'])
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

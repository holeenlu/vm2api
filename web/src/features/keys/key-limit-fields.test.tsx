import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KeyLimitFields } from './key-limit-fields'

const render = (limitsLocked: boolean) =>
  renderToStaticMarkup(
    <KeyLimitFields
      values={{ quota_usd: 5, ip_whitelist: '10.0.0.0/8' }}
      onChange={() => {}}
      limitsLocked={limitsLocked}
    />
  )

describe('KeyLimitFields', () => {
  it('disables quotas, rate limits and expiry but keeps IP lists editable for admin-managed keys', () => {
    const html = render(true)
    const locked = html.slice(0, html.indexOf('</fieldset>'))
    expect(locked).toMatch(/^<fieldset disabled=""/)
    expect(locked).toContain('type="number"')
    expect(locked).toContain('type="datetime-local"')
    const open = html.slice(html.indexOf('</fieldset>'))
    expect(open).toContain('value="10.0.0.0/8"')
  })

  it('leaves every limit editable otherwise', () => {
    expect(render(false)).not.toContain('disabled=""')
  })
})

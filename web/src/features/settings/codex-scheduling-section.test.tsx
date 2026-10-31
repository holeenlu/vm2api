import { createElement } from 'react'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CodexSchedulingSection } from './codex-scheduling-section'

it('renders translated policy choices and five bounded coefficients', async () => {
  for (const language of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
    await i18n.changeLanguage(language)
    const html = renderToStaticMarkup(
      createElement(CodexSchedulingSection, {
        value: {},
        disabled: false,
        onChange: () => {},
      })
    )
    expect(html).not.toContain('codexScheduling.')
    expect((html.match(/type="number"/g) || []).length).toBe(5)
    expect((html.match(/role="radio"/g) || []).length).toBe(7)
    expect(html).toContain('step="0.1"')
  }
  await i18n.changeLanguage('zh-CN')
})
it('hides smart coefficients for other strategies and disables changes while saving', () => {
  const html = renderToStaticMarkup(
    createElement(CodexSchedulingSection, {
      value: { strategy: 'round_robin' },
      disabled: true,
      onChange: () => {},
    })
  )
  expect(html).not.toContain('type="number"')
  expect((html.match(/disabled=""/g) || []).length).toBe(7)
})

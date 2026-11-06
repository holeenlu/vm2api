import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HealthPane } from './health-pane'

// The assertions below locate the control by its zh-CN accessible name.
const originalLanguage = i18n.language
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage)
})

function renderMinTokens(config: Record<string, unknown>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HealthPane, {
          title: 'Health',
          failover: {},
          healthProbe: undefined,
          compatibility: { min_max_tokens: config },
          onFailoverChange() {},
          onHealthProbeChange() {},
          onCompatibilityChange() {},
        })
      )
    )
  } finally {
    client.clear()
  }
}

describe('max_tokens mode display', () => {
  it.each([
    [{ mode: 'preserve' }, true],
    [{ mode: 'unchanged' }, true],
    [{ mode: '不改' }, true],
    [{ tier: 'preserve' }, true],
    [{ mode: ' preserve ' }, true],
    [{ no_raise: true }, true],
    [{ raise: false }, true],
    [{ mode: 'floor', no_raise: true }, false],
    [{ mode: 'default', raise: false }, false],
    [{ mode: 'raise', no_raise: true }, false],
    [{ mode: 'unknown', no_raise: true }, true],
    [{}, false],
  ] as const)('matches backend mode precedence for %j', (config, preserve) => {
    const html = renderMinTokens(config)
    const control = html.match(/<button[^>]*aria-label="不抬升"[^>]*>/)?.[0]
    expect(control).toBeDefined()
    expect(control).toContain(`aria-checked="${preserve}"`)
    expect(control).toContain(
      `data-state="${preserve ? 'checked' : 'unchecked'}"`
    )
  })
})

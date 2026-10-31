import { createElement } from 'react'
import { i18n } from '@/i18n'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import {
  endpointSaveRequest,
  draftFromStored,
} from '../anthropic/endpoint-save'
import { EndpointCard } from './endpoint-card'

const originalLanguage = i18n.language
afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

it('changes endpoint labels while preserving user names, keys, models and save payloads', async () => {
  const endpoint = {
    id: 'ep-1',
    kind: 'custom',
    protocol: 'anthropic',
    name: '自訂 <name>',
    base_url: 'https://upstream.example',
    models: [{ name: 'model-中文', alias: 'alias-日本語' }],
    api_key_entries: [{ id: 'key-1' }],
  } as ApiEndpoint
  const draft = draftFromStored({
    ...endpoint,
    api_key_entries: [{ id: 'key-1', proxy_id: 'proxy-1' }],
  })
  draft.apiKey = 'sk-private'
  const request = endpointSaveRequest(draft, 'model-中文')
  const edit = vi.fn()
  for (const [locale, expected] of [
    ['en-US', 'Custom'],
    ['zh-TW', '自訂'],
    ['ja-JP', 'カスタム'],
  ]) {
    await i18n.changeLanguage(locale)
    const html = renderToStaticMarkup(
      createElement(EndpointCard, { endpoint, busy: false, onEdit: edit })
    )
    expect(html).toContain(expected)
    expect(html).toContain('自訂 &lt;name&gt;')
    expect(html).toContain('alias-日本語')
    expect(endpointSaveRequest(draft, 'model-中文')).toEqual(request)
  }
  expect(request.body).toEqual({ key_id: 'key-1', api_key: 'sk-private' })
  expect(edit).not.toHaveBeenCalled()
})

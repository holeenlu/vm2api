import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { CodexCredentialPanel } from './codex-credential-panel'

const vm = {
  id: '',
  name: 'New',
  platform: 'openai',
  family: 'codex',
  can_import_credential: true,
} as Vm

function render(props: Partial<Parameters<typeof CodexCredentialPanel>[0]>) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <CodexCredentialPanel vm={vm} gatewayAccount {...props} />
      </QueryClientProvider>
    </I18nextProvider>
  )
}

function tabs(html: string) {
  return [
    ...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g),
  ].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
}

describe('CodexCredentialPanel BPS authorization', () => {
  it('keeps OAuth and the account file as the only methods', () => {
    expect(tabs(render({}))).toHaveLength(2)
    expect(tabs(render({ bpsImportPath: '/x' }))).toHaveLength(2)
    expect(tabs(render({}))).not.toContain('BPS')
  })

  it('switches the guidance to the Excel (bps.openai.com) flow for BPS', () => {
    expect(render({ bpsImportPath: '/x' })).toContain(
      i18n.t('common:codexBpsOAuthHelp')
    )
    expect(render({})).not.toContain(i18n.t('common:codexBpsOAuthHelp'))
  })
})

import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupPane } from './backup-pane'

const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP'] as const
afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

// 审计 U6：备份页说明备份不含主密钥文件、runtime-secrets.json 与 Worker 数据目录
describe('backup pane', () => {
  it('states what the panel backup leaves out in every locale', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    })
    for (const locale of locales) {
      await i18n.changeLanguage(locale)
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(BackupPane)
        )
      )
      for (const item of [
        'credential-master-keys.json',
        'runtime-secrets.json',
        'data/codex-gateway/',
      ])
        expect(html, locale).toContain(item)
      expect(html, locale).toContain(i18n.t('settings:backup.scopeHint'))
    }
  })
})

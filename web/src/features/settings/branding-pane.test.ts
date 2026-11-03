import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { brandingQuery, DEFAULT_BRANDING } from '@/context/branding-provider'
import { BrandingPane } from './branding-pane'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
describe('localized branding upload controls', () => {
  it.each([
    ['en-US', 'Choose image', 'No image selected'],
    ['zh-CN', '选择图片', '未选择图片'],
    ['zh-TW', '選擇圖片', '尚未選擇圖片'],
    ['ja-JP', '画像を選択', '画像が選択されていません'],
  ])(
    'renders accessible custom upload actions in %s',
    async (locale, choose, empty) => {
      await i18n.changeLanguage(locale)
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      client.setQueryData(brandingQuery().queryKey, DEFAULT_BRANDING)
      try {
        const html = renderToStaticMarkup(
          createElement(
            QueryClientProvider,
            { client },
            createElement(BrandingPane)
          )
        )
        const inputs = html.match(/<input[^>]*type="file"[^>]*>/g) || []
        expect(inputs).toHaveLength(2)
        for (const input of inputs) {
          expect(input).toContain('hidden=""')
          expect(input).toContain('class="hidden"')
          expect(input).toContain('accept="image/png,image/jpeg,image/webp"')
          const id = input.match(/id="([^"]+)"/)?.[1]
          expect(id).toBeTruthy()
          expect(html).toContain('for="' + id + '"')
          expect(html).toContain('id="' + id + '-status"')
          expect(html).toContain('aria-describedby="' + id + '-status"')
        }
        expect(html.split('>' + choose + '</').length - 1).toBe(2)
        expect(html.split(empty).length - 1).toBe(2)
        for (const key of ['branding.logoImage', 'branding.faviconImage']) {
          const name = i18n.t('settings:branding.chooseImage', {
            label: i18n.t('settings:' + key),
          })
          expect(html).toContain('aria-label="' + name + '"')
        }
      } finally {
        client.clear()
      }
    }
  )
  it('preserves the original filename in each localized selection message', async () => {
    const name = '使用者-logo_日本語.png'
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      await i18n.changeLanguage(locale)
      expect(i18n.t('settings:branding.selectedFile', { name })).toContain(name)
    }
  })
})

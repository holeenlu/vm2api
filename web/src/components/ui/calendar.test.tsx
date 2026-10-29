import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Calendar } from './calendar'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('calendar accessibility language', () => {
  it.each([
    ['en-US', 'Go to next month', 'selected'],
    ['zh-CN', '下个月', '已选'],
    ['zh-TW', '下個月', '已選取'],
    ['ja-JP', '翌月へ', '選択済み'],
  ])(
    'localizes date and navigation labels in %s',
    async (language, next, selected) => {
      await i18n.changeLanguage(language)
      const date = new Date(2026, 0, 15, 12)
      const html = renderToStaticMarkup(
        <Calendar mode='single' month={date} selected={date} />
      )
      expect(html).toContain(next)
      expect(html).toContain(selected)
      expect(html).not.toContain('Go to the Next Month')
    }
  )
})

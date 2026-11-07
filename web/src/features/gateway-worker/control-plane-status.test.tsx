import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPlaneStatusCard,
  type ControlPlaneStatus,
} from './control-plane-status'

const base: ControlPlaneStatus = {
  events: {
    since_hours: 24,
    by_status: { matched: 3, applied: 2, recorded: 1, diff: 1, pending: 4 },
    attempts: { failed: 0, retry: 2 },
    lag: [{ instance_id: 'gw-1', lag: 5 }],
  },
}

const render = (status: ControlPlaneStatus) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ControlPlaneStatusCard status={status} />
    </I18nextProvider>
  )

describe('ControlPlaneStatusCard (audit U8)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('summarises the event inbox', () => {
    const html = render(base)
    expect(html).toContain('已处理 6')
    expect(html).toContain('差异 1')
    expect(html).toContain('未拉取 gw-1 5 条')
  })

  it('marks an unreadable inbox', () => {
    const html = render({ ...base, events: null })
    expect(html.match(/读取失败/g)?.length).toBe(1)
  })
})

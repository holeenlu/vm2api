import { i18n, LOCALES } from '@/i18n'
import { afterEach, expect, it } from 'vitest'
import { proxyQualityMessage } from './proxy-quality-display'

const originalLanguage = i18n.language
afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})
it('uses structured outcomes across languages and leaves raw diagnostic text intact', async () => {
  const message = '原始诊断 <timeout> & upstream data'
  const item = {
    target: 'openai',
    status: 'pass' as const,
    http_status: 401,
    latency_ms: 31,
    message,
  }
  for (const { id } of LOCALES) {
    await i18n.changeLanguage(id)
    expect(proxyQualityMessage(item)).toBe(
      i18n.t('proxies:qualityHttpReachable', { status: 401 })
    )
    expect(
      proxyQualityMessage({ ...item, status: 'warn', http_status: 429 })
    ).toBe(i18n.t('proxies:qualityRateLimited'))
    expect(proxyQualityMessage({ ...item, status: 'challenge' })).toBe(
      i18n.t('proxies:qualityCloudflareChallenge')
    )
    expect(
      proxyQualityMessage({ ...item, status: 'fail', http_status: 500 })
    ).toBe(i18n.t('proxies:qualityUnexpectedStatus', { status: 500 }))
    expect(
      proxyQualityMessage({ ...item, status: 'fail', http_status: undefined })
    ).toBe(i18n.t('proxies:qualityConnectionFailed'))
    expect(proxyQualityMessage({ ...item, target: 'base_connectivity' })).toBe(
      i18n.t('proxies:qualityExitHealthy')
    )
    expect(item.message).toBe(message)
    expect(item.http_status).toBe(401)
  }
})

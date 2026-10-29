import { i18n } from '@/i18n'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  PROXY_LATENCY_WARN_MS,
  proxyFieldClass,
  proxyLatencyTone,
  proxySurfaceClass,
  vmProxyTone,
} from './proxy-tone'

describe('proxyLatencyTone', () => {
  it('marks available proxies green', () => {
    expect(
      proxyLatencyTone({ status: 'ok', enabled: true, latency_ms: 80 })
    ).toBe('ok')
    expect(proxyFieldClass('ok')).toBe('text-ok-3')
  })

  it('marks latency above 300ms yellow even when status is ok', () => {
    expect(
      proxyLatencyTone({
        status: 'ok',
        enabled: true,
        latency_ms: PROXY_LATENCY_WARN_MS + 1,
      })
    ).toBe('caution')
    expect(proxyFieldClass('caution')).toBe('text-caution-3')
  })

  it('marks dead or failed proxies red', () => {
    expect(proxyLatencyTone({ status: 'dead', latency_ms: 40 })).toBe('danger')
    expect(proxyLatencyTone({ status: 'fail', enabled: true })).toBe('danger')
    expect(proxyLatencyTone({ enabled: false, status: 'ok' })).toBe('danger')
    expect(proxyFieldClass('danger')).toBe('text-red-3')
  })
})

describe('vmProxyTone', () => {
  it('treats a live ticket without SOCKS5 as fail-closed red', () => {
    expect(vmProxyTone({ has_token: true })).toBe('danger')
    expect(proxySurfaceClass('danger')).toBe('bg-red-1 text-red-5')
  })

  it('keeps empty slots without a proxy as none', () => {
    expect(vmProxyTone({ has_token: false })).toBe('none')
  })
})

const initialLanguage = i18n.language
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
})

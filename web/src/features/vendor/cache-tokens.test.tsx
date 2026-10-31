import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CacheTokens, cacheTokenValue } from './cache-tokens'
import { UsageSummaryCards, UsageMetricCells } from './usage-metrics'

describe('supplier cache evidence display', () => {
  const row = {
    requests: 2,
    cache_read_tokens: 1200,
    cache_creation_tokens: 30,
    cache_read_known_requests: 2,
    cache_creation_known_requests: 0,
    cache_complete: false,
  }
  it('shows recorded reads even when writes are unknown', () => {
    expect(cacheTokenValue(row, 'read')).toBe('1,200')
    expect(cacheTokenValue(row, 'creation')).toBe('—')
    expect(renderToStaticMarkup(<CacheTokens usage={row} />)).toContain('1,200')
  })
  it('renders the seven requested metrics with precise cost and hit rate', async () => {
    await i18n.changeLanguage('zh-CN')
    const usage = {
      ...row,
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_known_requests: 2,
      cache_hit_rate: 0.9,
      cost_usd: 0.12345678,
    }
    const cards = renderToStaticMarkup(<UsageSummaryCards usage={usage} />)
    for (const label of [
      '请求数',
      '输入 Token',
      '输出 Token',
      '缓存读',
      '缓存写',
      '缓存命中率',
      '消耗总额',
    ])
      expect(cards).toContain(label)
    expect(cards).toContain('90.00%')
    expect(cards).toContain('$0.12345678')
    expect(cards).toContain('1.2K')
    expect(cards).toContain('title="1,200"')
    expect(
      renderToStaticMarkup(
        <table>
          <tbody>
            <tr>
              <UsageMetricCells usage={usage} />
            </tr>
          </tbody>
        </table>
      ).match(/<td/g)
    ).toHaveLength(7)
  })
  it('steps token units through K, M and B while keeping exact hover values', () => {
    const usage = {
      ...row,
      input_tokens: 999,
      output_tokens: 1000,
      cache_read_tokens: 1234567,
      cache_creation_tokens: 1234567890,
      cache_creation_known_requests: 2,
      cache_hit_rate: 0.5,
      cost_usd: 1,
    }
    const cards = renderToStaticMarkup(<UsageSummaryCards usage={usage} />)
    for (const value of [
      '999',
      '1.0K',
      '1.2M',
      '1.2B',
      'title="1,234,567"',
      'title="1,234,567,890"',
    ])
      expect(cards).toContain(value)
    const cells = renderToStaticMarkup(
      <table>
        <tbody>
          <tr>
            <UsageMetricCells
              usage={{ ...usage, cache_read_known_requests: 1 }}
            />
          </tr>
        </tbody>
      </table>
    )
    expect(cells).toContain('≥1.2M')
    expect(cells).toContain('title="≥1,234,567"')
  })
  it('marks partial sums and distinguishes unknown history from an empty period', () => {
    expect(
      cacheTokenValue({ ...row, cache_read_known_requests: 1 }, 'read')
    ).toBe('≥1,200')
    expect(cacheTokenValue({ ...row, requests: 0 }, 'creation')).toBe('0')
  })
})

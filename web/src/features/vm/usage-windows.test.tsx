import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { vmForecastRow } from '@/lib/vm-usage'
import { usageQueryOptions } from '@/features/overview/queries'
import { VmCostLedger, VmUsageWindows } from './usage-windows'

/** 账本读用量概览缓存里的明细覆盖起点；可选地预置它。 */
function withQuery(node: ReactNode, coverageStart?: string) {
  const qc = new QueryClient()
  if (coverageStart)
    qc.setQueryData(usageQueryOptions().queryKey, {
      billing: { log_coverage_start: coverageStart },
    })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>
  )
}

function render(five: number | null, seven: number | null) {
  const vm: Vm = {
    id: 'vm-fixture',
    platform: 'openai',
    family: 'codex',
    has_token: true,
    utilization_5h: five == null ? null : five / 100,
    utilization_7d: seven == null ? null : seven / 100,
    codex_usage: {
      windows: [
        { id: '5h', used_percent: five },
        { id: '7d', used_percent: seven },
      ],
    },
  }
  return renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
}

describe('Codex quota readings after a quota error', () => {
  it('renders unknown readings as dashes, not fabricated 0% or 100%', () => {
    const html = render(null, null)
    expect(html.match(/>—</g)).toHaveLength(2)
    expect(html).not.toMatch(/>\d+%</)
  })

  it('renders a measured cap without inventing the missing window', () => {
    const html = render(100, null)
    expect(html).toContain('100%')
    expect(html.match(/>—</g)).toHaveLength(1)
  })

  it('renders real refreshed measurements normally', () => {
    const html = render(2, 32)
    expect(html).toContain('2%')
    expect(html).toContain('32%')
    expect(html).not.toContain('>—<')
  })
})

describe('7D capacity forecast row in the list cost ledger', () => {
  const base: Vm = {
    id: 'vm-forecast',
    platform: 'openai',
    family: 'codex',
    has_token: true,
  }
  const estimate = (status: 'ok' | 'resampling', total: number | null) => ({
    status,
    spent_usd: 3,
    total_usd: total,
    remaining_usd: total == null ? null : total - 3,
    total_tokens: total == null ? null : 90100,
    used_ratio: 0.4,
  })

  it('shows the sampled capacity with an approximate sign only when opted in', () => {
    const vm = { ...base, estimate_7d: estimate('ok', 9.01) }
    const html = withQuery(<VmCostLedger vm={vm} forecast />)
    expect(html).toContain('≈$9.01')
    expect(html).toContain('≈90.1K')
    expect(withQuery(<VmCostLedger vm={vm} />)).not.toContain('≈$9.01')
  })

  it('renders a dash and explains why when the forecast has no number', () => {
    const vm = { ...base, estimate_7d: estimate('resampling', 12) }
    const html = withQuery(<VmCostLedger vm={vm} forecast />)
    expect(html).not.toContain('≈')
    expect(html).toContain('>—<')
    expect(vmForecastRow(vm).tooltip).toContain('\n')
    expect(vmForecastRow({}).cost).toBeNull()
  })

  it('labels the total with the usage-log coverage start and flags a partial 7D', async () => {
    await i18n.changeLanguage('zh-CN')
    const recent = new Date(Date.now() - 4 * 24 * 3600e3).toISOString()
    const html = withQuery(<VmCostLedger vm={base} />, recent)
    expect(html).toContain('7D*')
    expect(html).not.toContain('>总计<')
    expect(html).toMatch(/自 \d{2}-\d{2}/)
    const old = new Date(Date.now() - 9 * 24 * 3600e3).toISOString()
    const full = withQuery(<VmCostLedger vm={base} />, old)
    expect(full).not.toContain('7D*')
    expect(full).toMatch(/自 \d{2}-\d{2}/)
    expect(withQuery(<VmCostLedger vm={base} />)).toContain('>总计<')
  })
})

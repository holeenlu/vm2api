import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fableRow } from './usage-meter'
import { VmCostLedger, VmUsageWindows } from './usage-windows'

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

describe('Fable local ceiling display', () => {
  it('shows a Fable-specific limit without replacing the other quota windows', async () => {
    await i18n.changeLanguage('zh-CN')
    const vm: Vm = {
      id: 'fable-fixture',
      has_token: true,
      account_tier: 'max',
      utilization_5h: 0.1,
      utilization_7d: 0.2,
      utilization_7d_oi: 0.5,
      status_5h: 'allowed',
      status_7d: 'allowed',
      weekly_split: {
        enabled: true,
        fable_share: 0.5,
        fable_utilization: 0.5,
        fable_remaining: 0,
        fable_blocked: true,
      },
    }
    expect(fableRow(vm)).toEqual({ kind: 'note', text: 'Fable 已达 50% 上限' })
    const html = renderToStaticMarkup(<VmUsageWindows vm={vm} now={0} />)
    expect(html).toContain('Fable 已达 50% 上限')
    expect(html).not.toContain('普通半仓')
    expect(fableRow({ ...vm, weekly_split: { enabled: false } })).toEqual({
      kind: 'bar',
      pct: 50,
    })
  })
})

describe('7D projected total display', () => {
  it('shows the estimated money and tokens from the same 7D window', () => {
    const html = renderToStaticMarkup(
      <VmCostLedger
        vm={{
          id: 'estimate-fixture',
          window_7d_cost: 550.18,
          window_7d_tokens: 198200000,
          total_cost: 9999,
          total_tokens: 999999999,
          estimate_7d: {
            status: 'ok',
            spent_usd: 550.18,
            total_usd: 797.362319,
            total_tokens: 287246377,
            remaining_usd: 247.182319,
            used_ratio: 0.69,
          },
        }}
      />
    )
    expect(html).toContain('≈$797.36')
    expect(html).toContain('≈287.2M')
    expect(html).not.toContain('9999')
  })

  it('does not label lifetime spend as the projected weekly total', () => {
    const html = renderToStaticMarkup(
      <VmCostLedger vm={{ id: 'unknown-fixture', total_cost: 9999 }} />
    )
    expect(html.match(/>—</g)).toHaveLength(2)
    expect(html).not.toContain('$9999')
  })
})

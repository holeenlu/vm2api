import { useTranslation } from 'react-i18next'

export type PricingLine = {
  platform?: string | null
  pricing_version?: number
  pricing_source?: string
  effective_date?: string
  group_name?: string
  coefficient?: string | number
  price_cny_per_usd?: string | number
  exchange_rate?: string | number
  cost_usd: string | number
  amount_usdt: string | number
  requests?: number
}
export type PricingSnapshot = {
  lines?: PricingLine[]
  rate_breakdown?: PricingLine[]
  contract_version?: number | null
  pricing_versions?: {
    id: string
    version: number
    source: string
    effective_at: string
  }[]
  multiplier?: number | string
  fx_cny_per_usdt?: number | string
  exchange_rate?: number | string
}
const value = (raw: unknown) => {
  if (raw == null || raw === '') return '—'
  const [whole, fraction = ''] = String(raw).split('.')
  const tail = fraction.replace(/0+$/, '')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (tail ? '.' + tail : '')
}
export function PricingBreakdown({ snapshot }: { snapshot: PricingSnapshot }) {
  const { t } = useTranslation('supplierAdmin')
  const lines = snapshot.lines || snapshot.rate_breakdown || []
  if (!lines.length)
    return (
      <p className='text-xs text-muted-foreground'>
        {t('pricingLegacyNoLines')}
      </p>
    )
  return (
    <div className='overflow-x-auto rounded-lg border'>
      <table className='w-full min-w-[850px] text-xs'>
        <thead className='bg-muted/20'>
          <tr>
            {[
              'pricingVersion',
              'pricingDate',
              'pricingPlatform',
              'requests',
              'costUsd',
              'pricingUnit',
              'pricingFx',
              'totalUsdt',
            ].map((key) => (
              <th className='px-3 py-2 text-start font-medium' key={key}>
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const legacy = line.pricing_source !== 'global'
            const price =
              line.price_cny_per_usd ??
              (line.coefficient == null
                ? null
                : Number(line.coefficient) * Number(snapshot.multiplier || 1))
            return (
              <tr key={index} className='border-t [&_td]:px-3 [&_td]:py-2'>
                <td>{legacy ? t('pricingLegacy') : line.pricing_version}</td>
                <td>{line.effective_date || '—'}</td>
                <td>
                  {line.platform === 'anthropic'
                    ? 'Claude'
                    : line.platform === 'openai'
                      ? 'OpenAI'
                      : line.group_name || t('pricingLegacy')}
                </td>
                <td>{value(line.requests)}</td>
                <td>{value(line.cost_usd)}</td>
                <td>{value(price)}</td>
                <td>
                  {value(
                    line.exchange_rate ??
                      snapshot.exchange_rate ??
                      snapshot.fx_cny_per_usdt
                  )}
                </td>
                <td className='font-semibold'>{value(line.amount_usdt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

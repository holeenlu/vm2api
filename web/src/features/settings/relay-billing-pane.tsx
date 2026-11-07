import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SettingRow } from '@/components/setting-row'

// 低余额并发保护（审计阶段 1 W2）：routing.json `relay_billing`，金额按整数微单位保存
const MICROS = 1_000_000

type RelayBillingPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function RelayBillingPane({
  value: policy,
  onChange,
}: RelayBillingPaneProps) {
  const { t } = useTranslation('settings')
  const lowBalance = Number(policy.low_balance_micros ?? MICROS) / MICROS
  const maxInflight = Number(policy.low_balance_max_inflight ?? 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('relayBilling.title')}</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label={t('relayBilling.lowBalance')}
          desc={t('relayBilling.lowBalanceHelp')}
        >
          <Input
            className='w-28'
            type='number'
            min={0}
            step={0.01}
            value={lowBalance}
            onChange={(event) =>
              onChange({
                ...policy,
                low_balance_micros: Math.max(
                  0,
                  Math.round(Number(event.target.value) * MICROS) || 0
                ),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label={t('relayBilling.maxInflight')}
          desc={t('relayBilling.maxInflightHelp')}
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={1000}
            value={maxInflight}
            onChange={(event) =>
              onChange({
                ...policy,
                low_balance_max_inflight: Math.min(
                  1000,
                  Math.max(1, Math.round(Number(event.target.value)) || 1)
                ),
              })
            }
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}

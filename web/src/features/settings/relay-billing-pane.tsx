import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SettingRow } from '@/components/setting-row'

// 低余额并发保护（审计阶段 1 W2）：routing.json `relay_billing`，金额按整数微单位保存
const MICROS = 1_000_000
// 每日计费对账（审计阶段 2 W9）：UTC+8 的 HH:MM，空串关闭；unmetered 占比告警阈值按 0–1 保存，面板按百分比显示
const RECONCILE_AT = '03:30'
const UNMETERED_RATIO = 0.05

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
  const reconcileAt =
    typeof policy.reconcile_at === 'string' ? policy.reconcile_at : RECONCILE_AT
  const unmeteredPercent =
    Math.round(
      Number(policy.reconcile_unmetered_ratio ?? UNMETERED_RATIO) * 10000
    ) / 100

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
        <SettingRow
          label={t('relayBilling.reconcileAt')}
          desc={t('relayBilling.reconcileAtHelp')}
        >
          <Input
            className='w-28'
            type='time'
            aria-label={t('relayBilling.reconcileAt')}
            value={reconcileAt}
            onChange={(event) =>
              onChange({ ...policy, reconcile_at: event.target.value })
            }
          />
        </SettingRow>
        <SettingRow
          label={t('relayBilling.unmeteredRatio')}
          desc={t('relayBilling.unmeteredRatioHelp')}
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            max={100}
            step={0.5}
            aria-label={t('relayBilling.unmeteredRatio')}
            value={unmeteredPercent}
            onChange={(event) =>
              onChange({
                ...policy,
                reconcile_unmetered_ratio:
                  Math.min(100, Math.max(0, Number(event.target.value) || 0)) /
                  100,
              })
            }
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}

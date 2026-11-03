import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, panelFetch } from '@/lib/api'
import { fmtNum, fmtUsd } from '@/lib/format'
import { systemDateTime } from '@/lib/system-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  accountBase,
  accountQueryKey,
  type GatewayAccount,
  type GatewayAccountRuntime,
  type GatewayQuotaForecast,
} from './accounts-model'

type StatusResult = {
  results?: {
    instance_id?: string
    ok?: boolean
    data?: { account?: GatewayAccountRuntime }
  }[]
}

const when = (value?: string | null) =>
  value && Date.parse(value) > 0 ? systemDateTime(value).slice(0, 16) : '—'

// 账号错误保护：每个 Worker 实例独立计数与冻结，逐实例展示冻结、待探测与最近探测结果。
export function ProtectionPanel({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation('common')
  const status = useQuery({
    queryKey: [...accountQueryKey, account.id, 'status'],
    queryFn: () =>
      api<StatusResult>(`${accountBase}/${account.id}/status`, {
        method: 'POST',
      }),
    enabled: account.status !== 'archived' && !!account.runtime_account_id,
  })
  const rows = (status.data?.results || []).filter((row) => row.data?.account)
  const now = Date.now()
  return (
    <div className='space-y-2 rounded-lg border p-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='text-sm font-medium'>{t('codexProtectionTitle')}</div>
        <Button
          size='sm'
          variant='ghost'
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
          aria-label={t('codexProtectionTitle')}
        >
          <RefreshCw
            className={cn('size-3.5', status.isFetching && 'animate-spin')}
          />
        </Button>
      </div>
      {status.isError && (
        <p className='text-xs text-destructive'>
          {(status.error as Error).message}
        </p>
      )}
      {!status.isError && rows.length === 0 && (
        <p className='text-xs text-muted-foreground'>
          {status.isLoading ? t('loading') : t('unknown')}
        </p>
      )}
      {rows.map((row) => {
        const protection = row.data?.account?.protection
        const peer = row.data?.account?.peer_freeze
        const peerFrozen = !!peer && Date.parse(peer.until) > now
        const until = protection?.frozen_until
        const frozen =
          !!until &&
          Date.parse(until) > 0 &&
          (Date.parse(until) > now || protection?.requires_probe)
        return (
          <dl
            key={row.instance_id}
            className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-sm'
          >
            {rows.length > 1 && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexProtectionInstance')}
                </dt>
                <dd className='break-all'>{row.instance_id}</dd>
              </>
            )}
            <dt className='text-muted-foreground'>
              {t('codexProtectionState')}
            </dt>
            <dd className={cn(frozen && 'text-destructive')}>
              {frozen
                ? Date.parse(until!) > now
                  ? t('codexProtectionFrozenUntil', { time: when(until) })
                  : t('codexProtectionAwaitingProbe')
                : t('codexProtectionNormal')}
            </dd>
            {!frozen && peerFrozen && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexProtectionPeer')}
                </dt>
                <dd className='text-destructive'>
                  {t('codexProtectionPeerUntil', {
                    time: when(peer!.until),
                    source: peer!.source || '—',
                  })}
                </dd>
              </>
            )}
            {frozen && !!protection?.rules?.length && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexProtectionRules')}
                </dt>
                <dd>{protection.rules.map((rule) => rule.name).join(', ')}</dd>
              </>
            )}
            {!frozen && !!protection?.count && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexProtectionCount')}
                </dt>
                <dd>{protection.count}</dd>
              </>
            )}
            {!!protection?.last_probe_at &&
              Date.parse(protection.last_probe_at) > 0 && (
                <>
                  <dt className='text-muted-foreground'>
                    {t('codexProtectionLastProbe')}
                  </dt>
                  <dd className='break-words'>
                    {when(protection.last_probe_at)}
                    {protection.last_probe_error
                      ? ` · ${protection.last_probe_error}`
                      : ` · ${t('codexProtectionProbeOk')}`}
                  </dd>
                </>
              )}
          </dl>
        )
      })}
      <p className='text-xs text-muted-foreground'>
        {t('codexProtectionHint')}
      </p>
    </div>
  )
}

// 额度预测：只读估算，不参与计费与调度；样本不足或记录不连续时给出原因而不是数字。
export function ForecastPanel({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation('common')
  const forecast = useQuery({
    queryKey: [...accountQueryKey, account.id, 'quota-forecast'],
    queryFn: () =>
      api<{ forecasts: GatewayQuotaForecast[] }>(
        `${accountBase}/${account.id}/quota-forecast`
      ),
  })
  return (
    <div className='space-y-2 rounded-lg border p-3'>
      <div className='text-sm font-medium'>{t('codexForecastTitle')}</div>
      {forecast.isError && (
        <p className='text-xs text-destructive'>
          {(forecast.error as Error).message}
        </p>
      )}
      <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm'>
        {(forecast.data?.forecasts || []).map((item) => (
          <div key={item.period} className='contents'>
            <dt className='text-muted-foreground'>
              {t(`codexForecastPeriods.${item.period}`)}
              {item.extrapolated ? ` · ${t('codexForecastExtrapolated')}` : ''}
            </dt>
            <dd>
              {item.unavailable_reason ? (
                <span className='text-muted-foreground'>
                  {item.unavailable_reason}
                </span>
              ) : (
                <span>
                  {item.estimated_tokens != null &&
                    `${fmtNum(item.estimated_tokens)} tokens`}
                  {item.estimated_tokens != null &&
                    item.estimated_usd != null &&
                    ' · '}
                  {item.estimated_usd != null && fmtUsd(item.estimated_usd, 2)}
                  {(item.low_sample ||
                    item.incomplete_cost ||
                    item.incomplete_tokens) && (
                    <span className='ml-2 text-xs text-muted-foreground'>
                      {[
                        item.low_sample && t('codexForecastLowSample'),
                        (item.incomplete_cost || item.incomplete_tokens) &&
                          t('codexForecastIncomplete'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className='text-xs text-muted-foreground'>{t('codexForecastHint')}</p>
    </div>
  )
}

type ProfileResult = {
  profile: {
    display_name?: string | null
    username?: string | null
    image_url?: string | null
    has_stats_error?: boolean
    summary: {
      total_text_tokens?: number | null
      peak_tokens?: number | null
      longest_task_duration_ms?: number | null
      current_streak_days?: number | null
      longest_streak_days?: number | null
    }
    activity_insights: {
      fast_mode_percent?: number | null
      reasoning_effort?: string | null
      total_threads?: number | null
    }
  }
}
type SubscriptionResult = {
  subscription?: {
    expires_at: string
    will_renew?: boolean | null
    billing_period?: string | null
  } | null
}

// 官方头像经控制面与 Worker 流式代理（需要面板凭据，不能直接用 <img src>）
function useAvatar(accountId: string, source?: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!source) return
    let objectUrl: string | null = null
    let cancelled = false
    void panelFetch(
      `${accountBase}/${accountId}/avatar?source=${encodeURIComponent(source)}`
    )
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [accountId, source])
  return source ? url : null
}

// 账号个人资料：Codex Desktop 同源的累计统计与订阅周期，只读展示，查询失败不影响账号状态。
export function ProfilePanel({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation('common')
  const enabled = account.status !== 'archived' && !!account.runtime_account_id
  const profile = useQuery({
    queryKey: [...accountQueryKey, account.id, 'profile'],
    queryFn: () => api<ProfileResult>(`${accountBase}/${account.id}/profile`),
    enabled,
    retry: false,
  })
  const subscription = useQuery({
    queryKey: [...accountQueryKey, account.id, 'subscription'],
    queryFn: () =>
      api<SubscriptionResult>(`${accountBase}/${account.id}/subscription`),
    enabled,
    retry: false,
  })
  const data = profile.data?.profile
  const avatar = useAvatar(account.id, data?.image_url)
  const plan = subscription.data?.subscription
  const rows: [string, string][] = data
    ? [
        [
          t('codexProfileTokens'),
          data.summary.total_text_tokens != null
            ? fmtNum(data.summary.total_text_tokens)
            : '—',
        ],
        [
          t('codexProfilePeak'),
          data.summary.peak_tokens != null
            ? fmtNum(data.summary.peak_tokens)
            : '—',
        ],
        [
          t('codexProfileLongestTask'),
          data.summary.longest_task_duration_ms != null
            ? t('codexProfileMinutes', {
                value: Math.round(
                  data.summary.longest_task_duration_ms / 60_000
                ),
              })
            : '—',
        ],
        [
          t('codexProfileStreak'),
          t('codexProfileStreakValue', {
            value1: data.summary.current_streak_days ?? 0,
            value2: data.summary.longest_streak_days ?? 0,
          }),
        ],
        [
          t('codexProfileThreads'),
          data.activity_insights.total_threads != null
            ? fmtNum(data.activity_insights.total_threads)
            : '—',
        ],
        [
          t('codexProfileFastMode'),
          data.activity_insights.fast_mode_percent != null
            ? `${data.activity_insights.fast_mode_percent.toFixed(1)}%`
            : '—',
        ],
        [
          t('codexProfileReasoning'),
          data.activity_insights.reasoning_effort || '—',
        ],
      ]
    : []
  return (
    <div className='space-y-2 rounded-lg border p-3'>
      <div className='flex items-center gap-3'>
        {avatar ? (
          <img src={avatar} alt='' className='size-9 rounded-full' />
        ) : null}
        <div className='min-w-0'>
          <div className='text-sm font-medium'>{t('codexProfileTitle')}</div>
          {data?.display_name || data?.username ? (
            <div className='truncate text-xs text-muted-foreground'>
              {[data.display_name, data.username].filter(Boolean).join(' · ')}
            </div>
          ) : null}
        </div>
      </div>
      {profile.isError && (
        <p className='text-xs text-muted-foreground'>
          {t('codexProfileUnavailable')}
        </p>
      )}
      {data?.has_stats_error && (
        <p className='text-xs text-muted-foreground'>
          {t('codexProfileStatsError')}
        </p>
      )}
      <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-1 text-sm'>
        {rows.map(([label, value]) => (
          <div key={label} className='contents'>
            <dt className='text-muted-foreground'>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <dt className='text-muted-foreground'>
          {t('codexProfileSubscription')}
        </dt>
        <dd>
          {plan
            ? t(plan.will_renew ? 'codexProfileRenews' : 'codexProfileEnds', {
                value: when(plan.expires_at),
              })
            : '—'}
        </dd>
      </dl>
    </div>
  )
}

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, panelFetch } from '@/lib/api'
import { fmtNum, fmtUsd } from '@/lib/format'
import { systemDateTime } from '@/lib/system-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  accountBase,
  accountQueryKey,
  type GatewayAccount,
  type GatewayAccountRuntime,
  type GatewayCredits,
  type GatewayQuotaForecast,
  type GatewayQuotaResult,
} from './accounts-model'

type ResetCreditStatus = {
  enabled?: boolean
  next_discovery_at?: string
  next_consume_at?: string
  last_result?: string
}

type StatusResult = {
  results?: {
    instance_id?: string
    ok?: boolean
    data?: { account?: GatewayAccountRuntime; reset_credit?: ResetCreditStatus }
  }[]
}

const when = (value?: string | null) =>
  value && Date.parse(value) > 0 ? systemDateTime(value).slice(0, 16) : '—'

/** 详情页分区卡：与 VM 详情页相同的 Card 版式。 */
export function PanelCard({
  title,
  action,
  className,
  children,
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <Card className={className}>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>{title}</CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className='space-y-2 pt-0'>{children}</CardContent>
    </Card>
  )
}

function creditText(
  credits: GatewayCredits | undefined,
  t: (key: string) => string
) {
  if (!credits) return t('unknown')
  if (credits.unlimited) return t('codexCreditsUnlimited')
  if (!credits.has_credits) return t('codexCreditsNone')
  return credits.balance ?? t('codexCreditsAvailable')
}

// 额度查询与重置卡：查询读取上游 /wham/usage；消费重置卡在结果不明时复用同一幂等键重试。
export function QuotaPanel({
  account,
  onChanged,
}: {
  account: GatewayAccount
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [result, setResult] = useState<GatewayQuotaResult | null>(null)
  const [pending, setPending] = useState<'query' | 'reset' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [redeemId, setRedeemId] = useState<string | null>(null)
  const credits = result?.credits ?? account.quota?.credits
  const resetCredits = result?.reset_credits
  const buckets = Object.entries(account.quota?.buckets || {})
  async function query() {
    setPending('query')
    try {
      setResult(
        await api<GatewayQuotaResult>(`${accountBase}/${account.id}/quota`, {
          method: 'POST',
        })
      )
      await onChanged()
    } catch (error) {
      toast.error((error as Error).message || t('codexQuotaQueryFailed'))
    } finally {
      setPending(null)
    }
  }
  async function consume() {
    setPending('reset')
    try {
      const next = await api<GatewayQuotaResult & { code?: string }>(
        `${accountBase}/${account.id}/reset-credits`,
        {
          method: 'POST',
          body: JSON.stringify({
            credit_id: resetCredits?.credits[0]?.id,
            ...(redeemId ? { redeem_request_id: redeemId } : {}),
          }),
        }
      )
      setRedeemId(null)
      setResult(next)
      toast.success(t('codexResetCreditDone'))
      await onChanged()
    } catch (error) {
      const data = (
        error as { data?: { redeem_request_id?: string; outcome?: string } }
      ).data
      // 结果不明时保留幂等键，再次点击会用同一个键重试，不会重复消费
      if (data?.outcome === 'unknown' && data.redeem_request_id)
        setRedeemId(data.redeem_request_id)
      toast.error((error as Error).message || t('codexResetCreditFailed'))
    } finally {
      setPending(null)
      setConfirm(false)
    }
  }
  return (
    <PanelCard
      title={t('codexQuotaTitle')}
      action={
        <Button
          size='sm'
          variant='outline'
          disabled={!!pending || account.status === 'archived'}
          onClick={() => void query()}
        >
          <RefreshCw
            className={cn('size-3.5', pending === 'query' && 'animate-spin')}
          />
          {t('codexQuotaQuery')}
        </Button>
      }
    >
      <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm'>
        <dt className='text-muted-foreground'>{t('codexCredits')}</dt>
        <dd>{creditText(credits, t)}</dd>
        <dt className='text-muted-foreground'>{t('codexPlan')}</dt>
        <dd>
          {result?.plan_type ||
            account.quota?.plan_type ||
            account.config.plan ||
            '—'}
        </dd>
        <dt className='text-muted-foreground'>{t('codexResetCredits')}</dt>
        <dd className='flex items-center gap-2'>
          <span>
            {resetCredits ? resetCredits.available_count : t('unknown')}
          </span>
          {!!resetCredits?.available_count && (
            <Button
              size='sm'
              variant='secondary'
              disabled={!!pending}
              onClick={() => setConfirm(true)}
            >
              {redeemId ? t('codexResetCreditRetry') : t('codexResetCreditUse')}
            </Button>
          )}
        </dd>
        {buckets.map(([id, bucket]) => (
          <Fragment key={id}>
            <dt className='text-muted-foreground'>{bucket.limit_name || id}</dt>
            <dd>
              {[bucket.primary_window, bucket.secondary_window]
                .filter((window) => window?.used_percent != null)
                .map((window) => `${Math.round(Number(window!.used_percent))}%`)
                .join(' · ') || '—'}
              {bucket.limit_reached ? ` · ${t('codexQuotaBucketReached')}` : ''}
            </dd>
          </Fragment>
        ))}
      </dl>
      {result?.warning && (
        <p className='text-xs text-muted-foreground'>
          {t('codexQuotaPartial')}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!open && pending !== 'reset') setConfirm(false)
        }}
        title={t('codexResetCreditUse')}
        desc={t('codexResetCreditConfirm', { name: account.name })}
        confirmText={t('codexResetCreditUse')}
        isLoading={pending === 'reset'}
        handleConfirm={() => void consume()}
      />
    </PanelCard>
  )
}

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
    <PanelCard
      title={t('codexProtectionTitle')}
      action={
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
      }
    >
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
        const refreshFailure = row.data?.account?.last_refresh_failure
        const resetCredit = row.data?.reset_credit
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
            {!!refreshFailure?.at && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexRefreshFailure')}
                </dt>
                <dd className='break-words text-destructive'>
                  {[
                    when(refreshFailure.at),
                    refreshFailure.operation === 'manual_refresh'
                      ? t('codexRefreshManual')
                      : t('codexRefreshScheduled'),
                    refreshFailure.status
                      ? `HTTP ${refreshFailure.status}`
                      : '',
                    refreshFailure.code || '',
                    refreshFailure.message || '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </dd>
              </>
            )}
            {resetCredit?.enabled && !!resetCredit.next_discovery_at && (
              <>
                <dt className='text-muted-foreground'>
                  {t('codexResetCreditAuto')}
                </dt>
                <dd className='break-words'>
                  {resetCredit.next_consume_at
                    ? t('codexResetCreditNextConsume', {
                        time: when(resetCredit.next_consume_at),
                      })
                    : t('codexResetCreditNextDiscovery', {
                        time: when(resetCredit.next_discovery_at),
                      })}
                  {resetCredit.last_result
                    ? ` · ${t('codexResetCreditLastResult', { result: resetCredit.last_result })}`
                    : ''}
                </dd>
              </>
            )}
          </dl>
        )
      })}
      <p className='text-xs text-muted-foreground'>
        {t('codexProtectionHint')}
      </p>
    </PanelCard>
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
    <PanelCard title={t('codexForecastTitle')}>
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
    </PanelCard>
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

// 官方头像经控制面与 Worker 流式代理（需要面板凭据，不能直接用 <img src>）；地址由 Worker 取自账号资料，
// 这里的 source 只用来判断资料里是否有头像
function useAvatar(accountId: string, source?: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!source) return
    let objectUrl: string | null = null
    let cancelled = false
    void panelFetch(`${accountBase}/${accountId}/avatar`)
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
    <PanelCard title={t('codexProfileTitle')}>
      {avatar || data?.display_name || data?.username ? (
        <div className='flex items-center gap-3'>
          {avatar ? (
            <img src={avatar} alt='' className='size-9 rounded-full' />
          ) : null}
          <div className='min-w-0 truncate text-xs text-muted-foreground'>
            {[data?.display_name, data?.username].filter(Boolean).join(' · ')}
          </div>
        </div>
      ) : null}
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
    </PanelCard>
  )
}

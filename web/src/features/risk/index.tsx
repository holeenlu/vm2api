import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { t as translate, i18n } from '@/i18n'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { StatusMark } from '@/components/status-mark'
import {
  type DetailState,
  LogDetailDialog,
} from '@/features/logs/log-detail/log-detail-dialog'
import { AccountScopeSettings } from './account-scope'
import { Panel } from './blocks'
import { DistillSettings } from './distill-settings'
import { RiskFeed } from './feed'
import { GateRail, type StageState } from './gate-rail'
import { HardRegexSettings } from './hard-regex-settings'
import { HitTable } from './hits'
import {
  PASS_REASONS,
  STAGES,
  type StageId,
  type ViewKey,
  feedKindOf,
  share,
} from './model'
import { ModelSettings } from './model-settings'
import {
  distillQueryOptions,
  gateStatsQueryOptions,
  jevInterceptQueryOptions,
  refusalGuardsQueryOptions,
  riskFeedQueryOptions,
} from './queries'
import { RefusalSettings } from './refusal-settings'

const STATE_TONE = {
  on: {
    key: 'on',
    get text() {
      return translate('risk:enabled')
    },
    cls: 'ok',
  },
  off: {
    key: 'off',
    get text() {
      return translate('risk:disabled')
    },
    cls: 'off',
  },
  unset: {
    key: 'unset',
    get text() {
      return translate('risk:enabledWithoutUrl')
    },
    cls: 'caution',
  },
  loading: {
    key: 'loading',
    get text() {
      return translate('risk:loading')
    },
    cls: 'none',
  },
} as const

function FeedNote({ shown, more }: { shown: number; more: boolean }) {
  const { t: translate } = useTranslation('risk')

  if (!shown) return null
  return (
    <p className='border-t px-4 py-2 text-xs text-muted-foreground'>
      {more
        ? translate('risk:recentEntries', { count: shown })
        : translate('risk:todayEntries', { count: shown })}{' '}
      {translate('risk:requestDetailHint')}
    </p>
  )
}

export function RiskAuditPage() {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const search = useSearch({ from: '/_authenticated/risk' })
  const navigate = useNavigate({ from: '/risk' })
  const view: ViewKey = search.view ?? 'all'

  const stats = useQuery(gateStatsQueryOptions())
  const feed = useQuery(riskFeedQueryOptions(stats.data?.since))
  const distill = useQuery(distillQueryOptions())
  const jev = useQuery(jevInterceptQueryOptions())
  const refusal = useQuery(refusalGuardsQueryOptions())

  const [dirty, setDirty] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [focusRule, setFocusRule] = useState<string | null>(null)
  const onDirtyChange = useCallback((next: boolean) => setDirty(next), [])

  const go = (next: ViewKey) => {
    if (next === view) return
    if (dirty && !window.confirm(translate('risk:discardGateChanges'))) return
    setDirty(false)
    setFocusRule(null)
    void navigate({
      search: { view: next === 'all' ? undefined : next },
      replace: true,
    })
  }

  const states: Record<StageId, StageState> = {
    distill: distill.data ? (distill.data.enabled ? 'on' : 'off') : 'loading',
    'hard-regex': jev.data
      ? jev.data.hard_regex_enabled
        ? 'on'
        : 'off'
      : 'loading',
    refusal: refusal.data ? (refusal.data.enabled ? 'on' : 'off') : 'loading',
    jev: jev.data
      ? jev.data.enabled
        ? jev.data.base_url.trim()
          ? 'on'
          : 'unset'
        : 'off'
      : 'loading',
  }

  const blocks = stats.data?.blocks || []
  const passes = stats.data?.passes || []
  const rows = feed.data?.rows || []
  const blockedRows = rows.filter((row) => feedKindOf(row) !== 'upstream')
  const upstreamRows = rows.filter((row) => feedKindOf(row) === 'upstream')
  const open = (row: UsageLogRow) => setDetail({ row })
  const stage = STAGES.find((s) => s.id === view)
  const feedProps = {
    loading: feed.isLoading || stats.isLoading,
    error: (feed.error || stats.error) as Error | null,
    onOpen: open,
  }

  return (
    <PageHeader
      title={VIEW_TITLES.risk}
      description={translate('risk:pageDescription')}
      extra={
        <Button
          variant='outline'
          size='sm'
          className='cursor-pointer'
          disabled={stats.isFetching || feed.isFetching}
          onClick={() => {
            void qc.invalidateQueries({
              queryKey: gateStatsQueryOptions().queryKey,
            })
            void qc.invalidateQueries({ queryKey: ['panel', 'risk-feed'] })
          }}
        >
          <RefreshCw
            className={cn(
              'size-3.5',
              (stats.isFetching || feed.isFetching) &&
                'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden='true'
          />
          {translate('risk:refresh')}
        </Button>
      }
    >
      <AccountScopeSettings />

      <div className='mt-4'>
        <GateRail stats={stats.data} states={states} view={view} onView={go} />
      </div>
      {stats.error ? (
        <p className='mt-2 text-sm text-destructive' role='alert'>
          {translate('risk:todayStatsError', {
            error: (stats.error as Error).message,
          })}
        </p>
      ) : null}

      <div
        id='risk-panel'
        role='tabpanel'
        aria-labelledby={`risk-tab-${view}`}
        className='mt-6 space-y-6'
      >
        {stage ? (
          <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
            <h3 className='text-lg font-semibold tracking-tight'>
              {stage.name}
            </h3>
            <StatusMark tone={STATE_TONE[states[stage.id]]} />
            <p className='basis-full text-sm text-muted-foreground'>
              {stage.does}
            </p>
          </div>
        ) : null}

        {view === 'pass' ? (
          <div className='grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
            <Panel
              title={translate('risk:allowReasons')}
              hint={translate('risk:failOpenHint')}
            >
              <PassReasons
                rows={passes}
                total={(stats.data?.passed ?? 0) || 0}
              />
            </Panel>
            <Panel
              title={translate('risk:upstreamRefusal')}
              hint={translate('risk:upstreamRefusalHint')}
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <RiskFeed
                  {...feedProps}
                  rows={upstreamRows}
                  empty={translate('risk:noUpstreamRefusals')}
                  showKind={false}
                />
              </div>
              <FeedNote shown={upstreamRows.length} more={!!feed.data?.more} />
            </Panel>
          </div>
        ) : (
          <div className='grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'>
            <Panel
              title={translate('risk:todayHits')}
              hint={translate('risk:hitsHint')}
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <HitTable
                  rows={
                    stage ? blocks.filter((r) => r.by === stage.id) : blocks
                  }
                  showSource={!stage}
                  empty={
                    stats.isLoading
                      ? translate('risk:loading')
                      : stage
                        ? translate('risk:noGateBlocks')
                        : translate('risk:noBlocksToday')
                  }
                  action={(row) => {
                    if (!stage) {
                      return (
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 shrink-0 cursor-pointer px-2'
                          aria-label={translate('risk:goToGate', {
                            p0: row.label,
                          })}
                          onClick={() => go(row.by as ViewKey)}
                        >
                          <ArrowUpRight className='size-3.5' />
                        </Button>
                      )
                    }
                    if (stage.id !== 'hard-regex' || !row.rule) return null
                    return (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-7 shrink-0 cursor-pointer px-2 text-xs'
                        onClick={() => {
                          setFocusRule(row.rule)
                          document
                            .getElementById('risk-settings')
                            ?.scrollIntoView({ behavior: 'smooth' })
                        }}
                      >
                        {translate('risk:locateRule')}
                      </Button>
                    )
                  }}
                />
              </div>
            </Panel>
            <Panel
              title={
                stage
                  ? translate('risk:recentBlocks')
                  : translate('risk:blockHistory')
              }
              hint={stage ? undefined : translate('risk:blockHistoryHint')}
            >
              <div className='max-h-[34rem] overflow-y-auto'>
                <RiskFeed
                  {...feedProps}
                  rows={
                    stage
                      ? blockedRows.filter((r) => feedKindOf(r) === stage.id)
                      : blockedRows
                  }
                  empty={
                    stage
                      ? translate('risk:noGateBlocks')
                      : translate('risk:noBlocksToday')
                  }
                  showKind={!stage}
                />
              </div>
              <FeedNote
                shown={
                  stage
                    ? blockedRows.filter((r) => feedKindOf(r) === stage.id)
                        .length
                    : blockedRows.length
                }
                more={!!feed.data?.more}
              />
            </Panel>
          </div>
        )}

        {stage ? (
          <div id='risk-settings' className='scroll-mt-4'>
            <Panel
              title={translate('risk:settings')}
              hint={
                stage.id === 'refusal'
                  ? translate('risk:changesImmediate')
                  : translate('risk:saveChangesHint')
              }
            >
              {stage.id === 'distill' ? (
                <DistillSettings onDirtyChange={onDirtyChange} />
              ) : stage.id === 'hard-regex' ? (
                <HardRegexSettings
                  focusRule={focusRule}
                  onDirtyChange={onDirtyChange}
                />
              ) : stage.id === 'refusal' ? (
                <RefusalSettings />
              ) : (
                <ModelSettings onDirtyChange={onDirtyChange} />
              )}
            </Panel>
          </div>
        ) : null}
      </div>

      <LogDetailDialog state={detail} onClose={() => setDetail(null)} />
    </PageHeader>
  )
}

function PassReasons({
  rows,
  total,
}: {
  rows: { by: string; count: number }[]
  total: number
}) {
  useTranslation('risk')

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.by] = (counts[row.by] || 0) + row.count
  const keys = Object.keys(PASS_REASONS).filter(
    (by) => counts[by] || by === 'fail-open'
  )
  return (
    <ul className='divide-y'>
      {keys.map((by) => {
        const count = counts[by] || 0
        const risky = by === 'fail-open' && count > 0
        return (
          <li key={by} className='flex items-center gap-3 px-4 py-3'>
            <div className='min-w-0 flex-1'>
              <p
                className={cn(
                  'text-sm',
                  risky && 'font-medium text-[var(--status-caution)]'
                )}
              >
                {PASS_REASONS[by].label}
              </p>
              <p className='text-xs text-muted-foreground'>
                {PASS_REASONS[by].hint}
              </p>
            </div>
            <span className='text-sm font-medium tabular-nums'>
              {count.toLocaleString(i18n.language)}
            </span>
            <span className='w-14 text-right text-xs text-muted-foreground tabular-nums'>
              {share(count, total)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

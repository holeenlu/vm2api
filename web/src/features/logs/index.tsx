import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { VIEW_DESCRIPTIONS, VIEW_TITLES } from '@/config/nav'
import type { ErrorCollection } from '@/types/panel-logs'
import { Download, Expand, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import {
  ERROR_CLASS_IDS,
  resolveMutedClasses,
  writeMutedClasses,
} from '@/lib/log-mute'
import { opsSince } from '@/lib/ops-window'
import { systemDateTime } from '@/lib/system-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { meQueryOptions } from '@/features/auth/queries'
import { errorClassLabel } from '@/features/logs/log-display'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  readHiddenColumns,
  writeHiddenColumns,
  type LogsTableColumn,
} from './column-visibility'
import { ColumnVisibilityDropdown } from './column-visibility-dropdown'
import { ErrorCollectionPanel } from './error-collection-panel'
import { ExportDialog, type ExportOptions } from './export-dialog'
import { exportQuery } from './export-query'
import {
  canFilterLogUsers,
  filtersForRole,
  type LogsTab,
} from './filter-policy'
import { UsageLogsFilters } from './filters/usage-logs-filters'
import {
  LogDetailDialog,
  type DetailState,
} from './log-detail/log-detail-dialog'
import { LogsFullscreen } from './logs-fullscreen'
import {
  LOGS_QUERY_KEY,
  USAGE_LOGS_QUERY_KEY,
  logStatsQueryOptions,
} from './queries'
import {
  activeFilterCount,
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  type LogsFilterState,
} from './search'
import { UsageLogsStatsPanel } from './usage-logs-stats-panel'
import { UsageRankings } from './usage-rankings'
import { VirtualizedLogsTable, type OpenDetail } from './virtualized-logs-table'

const route = getRouteApi('/_authenticated/logs')

function normalizedErrorCollection(value: unknown): ErrorCollection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  return {
    total: Number.isFinite(Number(raw.total)) ? Number(raw.total) : undefined,
    by_class: Array.isArray(raw.by_class) ? raw.by_class : [],
    by_code: Array.isArray(raw.by_code) ? raw.by_code : [],
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    ingress_hits: Array.isArray(raw.ingress_hits) ? raw.ingress_hits : [],
  }
}

export function LogsPage() {
  const { t: translate } = useTranslation('logs')

  const qc = useQueryClient()
  const navigate = route.useNavigate()
  const search = route.useSearch()
  const me = useQuery(meQueryOptions())
  const role = me.data?.role
  const isAdmin = canFilterLogUsers(role, search.scope)
  const user = me.data?.user ?? ''

  const filters = useMemo(
    () => filtersForRole(searchToFilters(search), role),
    [search, role]
  )
  const errorClass =
    filters.errorClass && ERROR_CLASS_IDS.includes(filters.errorClass)
      ? filters.errorClass
      : ''

  const [selectedTab, setTab] = useState<LogsTab>('detail')
  const tab = selectedTab === 'user' && !isAdmin ? 'key' : selectedTab
  const [isAutoRefresh, setIsAutoRefresh] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [mutedOverride, setMutedOverride] = useState<string[] | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<LogsTableColumn[]>([])
  useEffect(() => {
    if (user) setHiddenColumns(readHiddenColumns(user))
  }, [user])

  // 屏蔽集来自 stats 响应而非 `GET /routing`：后者只对 admin 放行。
  const since = opsSince('1h')
  const stats = useQuery(
    logStatsQueryOptions(since, undefined, 'hour', filters.scope)
  )
  const muted =
    mutedOverride ?? resolveMutedClasses(stats.data?.muted_error_classes)
  const errorCollection = normalizedErrorCollection(
    stats.data?.window?.error_collection
  )

  const apiFilters = useMemo(
    () => ({
      ...filtersToApi(filters, muted),
      ...(search.scope === 'mine' ? { scope: 'mine' as const } : {}),
      ...(tab === 'errors' ? { errorsOnly: true } : {}),
    }),
    [filters, muted, search.scope, tab]
  )
  const filterCount = activeFilterCount(filters)

  const applyFilters = useCallback(
    (next: LogsFilterState) => {
      void navigate({ search: filtersToSearch(filtersForRole(next, role)) })
    },
    [navigate, role]
  )

  const saveMuted = useMutation({
    mutationFn: (next: string[]) =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ logging: { muted_error_classes: next } }),
      }),
    onSuccess: () => {
      toast.success(translate('logs:muteSettingsSaved'))
      void qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey })
    },
    onError: (error: Error) =>
      toast.error(error.message || translate('logs:saveFailed')),
  })

  function handleToggleMute(id: string) {
    const willMute = !muted.includes(id)
    const next = willMute ? [...muted, id] : muted.filter((m) => m !== id)
    setMutedOverride(next)
    writeMutedClasses(next)
    // 屏蔽当前正在下钻的类时，钻取会与屏蔽态自相矛盾 —— 退回全部类。
    if (willMute && errorClass === id)
      applyFilters({ ...filters, errorClass: undefined })
    // 非 admin 只存本地，不触发 PUT（后端 ACL 只放行 GET）。
    if (role === 'super_admin') saveMuted.mutate(next)
    void qc.invalidateQueries({ queryKey: USAGE_LOGS_QUERY_KEY })
    void qc.invalidateQueries({ queryKey: LOGS_QUERY_KEY })
  }

  async function handleRefresh() {
    setIsRefreshing(true)
    await Promise.all([
      qc.invalidateQueries({ queryKey: USAGE_LOGS_QUERY_KEY }),
      qc.invalidateQueries({
        queryKey: logStatsQueryOptions(since, undefined, 'hour', filters.scope)
          .queryKey,
      }),
    ])
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
  }, [])

  async function enterFullscreen() {
    setIsFullscreen(true)
    // 原生全屏被拒绝也没关系：覆盖层照样铺满视口。
    try {
      await document.documentElement.requestFullscreen()
    } catch {
      /* noop */
    }
  }

  // 浏览器 ESC 退出原生全屏时同步收掉覆盖层。
  useEffect(() => {
    if (!isFullscreen) return
    const onChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [isFullscreen])

  const openDetail: OpenDetail = useCallback((row, opts) => {
    setDetail({
      row,
      tab: opts?.tab,
      chainIndex: opts?.chainIndex,
      scrollToRedirect: opts?.scrollToRedirect,
    })
  }, [])

  async function handleExport(opts: ExportOptions, signal?: AbortSignal) {
    try {
      const qs = exportQuery(opts, filters, muted, tab === 'errors')
      const res = await panelFetch(`/api/panel/request-logs/export?${qs}`, {
        signal,
      })
      if (!res.ok)
        throw new ApiError(translate('logs:exportFailed'), res.status)
      // 只有受信 Origin 能读到这三个头；其余跨域场景为 null，下方按缺失处理。
      const count = Number(res.headers.get('x-kin-export-count') ?? NaN)
      const total = Number(res.headers.get('x-kin-export-total') ?? NaN)
      const truncated = res.headers.get('x-kin-export-truncated') === '1'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tapmodels-logs-${systemDateTime().replace(/[:T]/g, '')}.${opts.format}`
      a.click()
      URL.revokeObjectURL(url)
      if (truncated && Number.isFinite(count) && Number.isFinite(total)) {
        toast.success(
          translate('logs:downloadTruncated', {
            p0: count,
            p1: total,
            p2: opts.limit,
          })
        )
      } else if (Number.isFinite(count)) {
        toast.success(translate('logs:downloadCount', { count: count }))
      } else {
        toast.success(translate('logs:downloaded'))
      }
    } catch (error) {
      if (signal?.aborted) return
      toast.error(
        error instanceof Error ? error.message : translate('logs:exportFailed')
      )
      throw error
    }
  }

  const currentSummary = [
    filters.statusCode != null
      ? translate('logs:statusFilter', { p0: filters.statusCode })
      : filters.excludeStatus200
        ? translate('logs:non2xx')
        : translate('logs:allStatuses'),
    errorClass
      ? translate('logs:errorClassFilter', {
          p0: errorClassLabel(errorClass),
        })
      : null,
    !errorClass && muted.length
      ? translate('logs:excludedMutedClasses', { count: muted.length })
      : null,
    filters.model ? translate('logs:modelFilter', { p0: filters.model }) : null,
    filters.sessionId
      ? translate('logs:sessionFilterLabel', { p0: filters.sessionId })
      : null,
    filters.endpoint
      ? translate('logs:endpointFilter', { p0: filters.endpoint })
      : null,
    filterCount > 0
      ? translate('logs:filterCount', { count: filterCount })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <PageHeader
      title={VIEW_TITLES.logs}
      description={VIEW_DESCRIPTIONS.logs}
      fluid
    >
      <div className='rounded-lg border border-border/60 bg-card'>
        <div className='flex flex-wrap gap-1 border-b p-2'>
          {(
            ['detail', 'errors', ...(isAdmin ? ['user'] : []), 'key'] as const
          ).map((t) => (
            <Button
              type='button'
              key={t}
              variant={tab === t ? 'default' : 'outline'}
              onClick={() => setTab(t as typeof tab)}
            >
              {t === 'detail'
                ? translate('logs:details')
                : t === 'errors'
                  ? translate('logs:error')
                  : t === 'user'
                    ? translate('logs:userRankings')
                    : translate('logs:keyRankings')}
            </Button>
          ))}
        </div>
        <UsageLogsFilters
          role={role}
          filters={filters}
          onApply={applyFilters}
          onReset={() => applyFilters({ scope: filters.scope })}
          actions={
            <>
              {Boolean(role) && (tab === 'detail' || tab === 'errors') && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-8 gap-1.5 text-xs'
                  onClick={() => setExportOpen(true)}
                >
                  <Download className='h-3.5 w-3.5' />
                  {translate('logs:export')}
                </Button>
              )}
              {(tab === 'detail' || tab === 'errors') && (
                <>
                  <ColumnVisibilityDropdown
                    role={role}
                    hidden={hiddenColumns}
                    onChange={(next) => {
                      setHiddenColumns(next)
                      if (user) writeHiddenColumns(user, next)
                    }}
                  />
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    onClick={() => void enterFullscreen()}
                    className='h-8 w-8'
                    aria-label={translate('logs:fullscreen')}
                  >
                    <Expand className='h-3.5 w-3.5' />
                  </Button>
                </>
              )}
              <Button
                type='button'
                variant='ghost'
                size='icon'
                onClick={() => void handleRefresh()}
                className='h-8 w-8'
                disabled={isFullscreen}
                aria-label={translate('logs:refresh')}
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
                />
              </Button>
              {(tab === 'detail' || tab === 'errors') && (
                <div className='ml-1 flex items-center gap-1.5 border-l border-border/40 pl-2'>
                  {isAutoRefresh ? (
                    <span className='relative flex h-1.5 w-1.5'>
                      <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75' />
                      <span className='relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500' />
                    </span>
                  ) : null}
                  <Switch
                    checked={isAutoRefresh}
                    onCheckedChange={setIsAutoRefresh}
                    disabled={isFullscreen}
                    aria-label={
                      isAutoRefresh
                        ? translate('logs:stopAutoRefresh')
                        : translate('logs:startAutoRefresh')
                    }
                  />
                </div>
              )}
            </>
          }
        />
      </div>
      <div className='mt-3 space-y-3'>
        {tab === 'errors' ? (
          <>
            <p className='text-xs text-muted-foreground'>
              {translate('logs:recentErrors')}
            </p>
            <ErrorCollectionPanel
              collection={errorCollection}
              muted={muted}
              activeClass={errorClass}
              onToggleMute={handleToggleMute}
              onSelectClass={(id) =>
                applyFilters({
                  ...filters,
                  errorClass: id === errorClass ? undefined : id,
                })
              }
            />
          </>
        ) : null}
        {filterCount > 0 ? <UsageLogsStatsPanel filters={apiFilters} /> : null}
        <div className='overflow-hidden rounded-lg border border-border/60'>
          {tab === 'user' || tab === 'key' ? (
            <UsageRankings
              filters={apiFilters}
              scope={tab}
              canSeeMoney={Boolean(role)}
              showOwner={role !== 'user'}
              onSelect={(id) => {
                applyFilters({
                  ...filters,
                  ...(tab === 'user' ? { userId: id } : { keyId: id }),
                })
                setTab('detail')
              }}
            />
          ) : (
            <VirtualizedLogsTable
              role={role}
              filters={apiFilters}
              autoRefreshEnabled={!isFullscreen && isAutoRefresh}
              hiddenColumns={hiddenColumns}
              onOpenDetail={openDetail}
            />
          )}
        </div>
      </div>
      <LogDetailDialog state={detail} onClose={() => setDetail(null)} />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        currentSummary={currentSummary}
        onExport={handleExport}
      />
      {isFullscreen ? (
        <LogsFullscreen
          role={role}
          title={VIEW_TITLES.logs}
          filters={apiFilters}
          onOpenDetail={openDetail}
          onExit={exitFullscreen}
        />
      ) : null}
    </PageHeader>
  )
}

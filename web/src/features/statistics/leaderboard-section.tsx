import { type ReactNode, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t, i18n } from '@/i18n'
import type {
  LeaderboardEntry,
  LeaderboardScope,
  StatsRange,
} from '@/types/panel-statistics'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Award,
  Medal,
  Trophy,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import {
  formatCurrency,
  formatDuration,
  formatTokenAmount,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntryName } from './leaderboard-card'
import { leaderboardQueryOptions } from './queries'

const PERIODS: { id: StatsRange; label: string; empty: string }[] = [
  {
    id: 'today',
    get label() {
      return t('statistics:today')
    },
    get empty() {
      return t('statistics:noTodayData')
    },
  },
  {
    id: '7days',
    get label() {
      return t('statistics:sevenDays')
    },
    get empty() {
      return t('statistics:noData')
    },
  },
  {
    id: '30days',
    get label() {
      return t('statistics:thirtyDays')
    },
    get empty() {
      return t('statistics:noData')
    },
  },
  {
    id: 'thisMonth',
    get label() {
      return t('statistics:thisMonth')
    },
    get empty() {
      return t('statistics:noMonthData')
    },
  },
]

const SCOPE_LABELS: Record<LeaderboardScope, string> = {
  get user() {
    return t('statistics:user')
  },
  get key() {
    return t('statistics:key')
  },
  get vm() {
    return t('statistics:provider')
  },
  get model() {
    return t('statistics:model')
  },
  get group() {
    return t('statistics:group')
  },
  get endpoint() {
    return t('statistics:entry')
  },
}

const LIMIT = 50

type SortKey =
  | 'totalRequests'
  | 'totalTokens'
  | 'totalCost'
  | 'totalActualCost'
  | 'successRate'
  | 'avgDurationMs'
  | 'avgTtftMs'
  | 'cacheHitRate'

type Column = {
  key: SortKey
  header: string
  mono?: boolean
  /** 未排序时加粗，标记默认的排序口径（后端按 totalCost 降序）。 */
  defaultBold?: boolean
  value: (row: LeaderboardEntry) => number | null
  cell: (row: LeaderboardEntry) => ReactNode
}

function cacheHitClass(pct: number) {
  if (pct >= 85) return 'text-green-600 dark:text-green-400'
  if (pct >= 60) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-orange-600 dark:text-orange-400'
}

const COLUMNS: Column[] = [
  {
    key: 'totalRequests',
    get header() {
      return t('statistics:requestCount')
    },
    value: (row) => row.totalRequests,
    cell: (row) => row.totalRequests.toLocaleString(i18n.language),
  },
  {
    key: 'totalTokens',
    get header() {
      return t('statistics:tokenCount')
    },
    value: (row) => row.totalTokens,
    cell: (row) => formatTokenAmount(row.totalTokens),
  },
  {
    key: 'totalCost',
    get header() {
      return t('statistics:spending')
    },
    mono: true,
    defaultBold: true,
    value: (row) => row.totalCost,
    cell: (row) => formatCurrency(row.totalCost),
  },
  {
    key: 'totalActualCost',
    get header() {
      return t('statistics:collected')
    },
    mono: true,
    value: (row) => row.totalActualCost,
    cell: (row) => formatCurrency(row.totalActualCost),
  },
  {
    key: 'successRate',
    get header() {
      return t('statistics:successRate')
    },
    value: (row) => (row.totalRequests > 0 ? row.successRate : null),
    cell: (row) =>
      row.totalRequests > 0 ? (
        `${(row.successRate * 100).toFixed(1)}%`
      ) : (
        <span className='text-muted-foreground'>-</span>
      ),
  },
  {
    key: 'avgDurationMs',
    get header() {
      return t('statistics:averageResponse')
    },
    value: (row) => row.avgDurationMs,
    cell: (row) => formatDuration(row.avgDurationMs),
  },
  {
    key: 'avgTtftMs',
    get header() {
      return t('statistics:averageTtft')
    },
    value: (row) => row.avgTtftMs,
    cell: (row) =>
      row.avgTtftMs && row.avgTtftMs > 0
        ? `${Math.round(row.avgTtftMs).toLocaleString(i18n.language)} ms`
        : '-',
  },
  {
    key: 'cacheHitRate',
    get header() {
      return t('statistics:cacheHitRate')
    },
    value: (row) => row.cacheHitRate,
    cell: (row) => {
      const pct = Number(row.cacheHitRate || 0) * 100
      return <span className={cacheHitClass(pct)}>{pct.toFixed(1)}%</span>
    },
  },
]

function RankCell({ rank }: { rank: number }) {
  useTranslation('statistics')

  const icon =
    rank === 1 ? (
      <Trophy className='h-4 w-4 text-yellow-500' />
    ) : rank === 2 ? (
      <Medal className='h-4 w-4 text-gray-400' />
    ) : rank === 3 ? (
      <Award className='h-4 w-4 text-orange-600' />
    ) : (
      <div className='h-4 w-4' />
    )
  const badgeClass =
    rank === 1
      ? 'bg-yellow-500 hover:bg-yellow-600'
      : rank === 2
        ? 'bg-gray-400 text-white hover:bg-gray-500'
        : rank === 3
          ? 'bg-orange-600 text-white hover:bg-orange-700'
          : undefined
  return (
    <div className='flex items-center gap-1.5'>
      {icon}
      <Badge
        variant={rank === 1 ? 'default' : rank <= 3 ? 'secondary' : 'outline'}
        className={cn('min-w-[32px] justify-center', badgeClass)}
      >
        #{rank}
      </Badge>
    </div>
  )
}

export function LeaderboardSection({
  scopes,
  tz,
  scope,
  onScopeChange,
}: {
  scopes: LeaderboardScope[]
  tz: string
  scope: LeaderboardScope
  onScopeChange: (scope: LeaderboardScope) => void
}) {
  const { t } = useTranslation('statistics')

  const canSeeMoney = useAuthStore((s) => Boolean(s.me?.role))
  const visibleColumns = COLUMNS.filter(
    (c) => canSeeMoney || !['totalCost', 'totalActualCost'].includes(c.key)
  )
  const [period, setPeriod] = useState<StatsRange>('today')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const board = useQuery(leaderboardQueryOptions(period, scope, LIMIT, tz))
  const entries = board.data?.entries

  const sorted = useMemo(() => {
    const rows = entries ?? []
    const column = COLUMNS.find((col) => col.key === sortKey)
    if (!column) return rows
    return [...rows].sort((a, b) => {
      const va = column.value(a)
      const vb = column.value(b)
      // 空值永远排在实值之后，不随方向翻转。
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [entries, sortKey, sortDir])

  // hub 的三态循环：升序 → 降序 → 取消。
  const handleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortKey(null)
    }
  }

  const isBold = (col: Column) =>
    sortKey === col.key || (sortKey === null && col.defaultBold)
  const empty =
    PERIODS.find((p) => p.id === period)?.empty ?? t('statistics:noData')

  return (
    <section className='w-full'>
      <h3 className='mb-3 text-base font-semibold'>
        {t('statistics:leaderboard')}
      </h3>
      <div className='mb-4 flex flex-wrap items-start gap-4'>
        <div className='flex min-w-[220px] flex-1 flex-col gap-2'>
          <Tabs
            value={scope}
            onValueChange={(value) => onScopeChange(value as LeaderboardScope)}
          >
            <TabsList
              className='grid w-full'
              style={{
                gridTemplateColumns: `repeat(${scopes.length}, minmax(0, 1fr))`,
              }}
            >
              {scopes.map((item) => (
                <TabsTrigger key={item} value={item}>
                  {SCOPE_LABELS[item]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className='mb-6 flex items-center gap-1'>
        {PERIODS.map((item) => (
          <Button
            key={item.id}
            variant={period === item.id ? 'default' : 'outline'}
            size='sm'
            className='h-8'
            onClick={() => setPeriod(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {board.isLoading ? (
        <Card>
          <CardContent className='space-y-4 py-6'>
            <div className='space-y-2'>
              {Array.from({ length: 6 }).map((_, row) => (
                <div
                  key={row}
                  className='grid gap-4'
                  style={{
                    gridTemplateColumns: `repeat(${visibleColumns.length + 2}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: visibleColumns.length + 2 }).map(
                    (_, col) => (
                      <Skeleton key={col} className='h-4 w-full' />
                    )
                  )}
                </div>
              ))}
            </div>
            <div className='text-center text-xs text-muted-foreground'>
              {t('statistics:loading')}
            </div>
          </CardContent>
        </Card>
      ) : board.error && !board.data ? (
        <Card>
          <CardContent className='py-8'>
            <div className='text-center text-destructive'>
              {t('statistics:rankingError')}
            </div>
          </CardContent>
        </Card>
      ) : sorted.length === 0 ? (
        <Card>
          <CardContent className='py-8'>
            <div className='text-center text-muted-foreground'>{empty}</div>
          </CardContent>
        </Card>
      ) : (
        <Card className='py-0'>
          <CardContent className='p-0'>
            <div className='rounded-md border'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='w-24'>
                      {t('statistics:rank')}
                    </TableHead>
                    <TableHead>{SCOPE_LABELS[scope]}</TableHead>
                    {visibleColumns.map((col) => (
                      <TableHead
                        key={col.key}
                        className={cn(
                          'cursor-pointer text-right transition-colors select-none hover:bg-muted/50',
                          col.mono && 'font-mono'
                        )}
                        aria-sort={
                          sortKey === col.key
                            ? sortDir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                        onClick={() => handleSort(col.key)}
                      >
                        <div
                          className={cn(
                            'flex items-center justify-end',
                            isBold(col) && 'font-bold'
                          )}
                        >
                          {col.header}
                          {sortKey !== col.key ? (
                            <ArrowUpDown className='ml-1 h-3 w-3 text-muted-foreground/50' />
                          ) : sortDir === 'asc' ? (
                            <ArrowUp className='ml-1 h-3 w-3' />
                          ) : (
                            <ArrowDown className='ml-1 h-3 w-3' />
                          )}
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((row, index) => (
                    <TableRow
                      key={row.id}
                      className={cn(index < 3 && 'bg-muted/50')}
                    >
                      <TableCell>
                        <RankCell rank={index + 1} />
                      </TableCell>
                      <TableCell
                        className={cn(
                          'max-w-[280px]',
                          scope === 'model' && 'font-mono text-sm'
                        )}
                      >
                        <EntryName entry={row} scope={scope} />
                      </TableCell>
                      {visibleColumns.map((col) => (
                        <TableCell
                          key={col.key}
                          className={cn(
                            'text-right tabular-nums',
                            col.mono && 'font-mono',
                            isBold(col) && 'font-bold'
                          )}
                        >
                          {col.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  )
}

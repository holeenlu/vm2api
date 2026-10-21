import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type { PricingEntry } from '@/types/panel-pricing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { EmptyState } from '@/components/empty-state'
import { QueryGate } from '@/components/query-gate'
import {
  fmtBaseRates,
  fmtPerM,
  modeKeys,
  priceSourceLabel,
  priceSourceVariant,
  tiersSummary,
} from '@/features/models/price-display'
import { PriceOverrideDialog } from '@/features/models/price-override-dialog'
import {
  invalidatePricing,
  pricingQueryOptions,
} from '@/features/models/queries'
import { RepriceDialog } from '@/features/models/reprice-dialog'
import { type ModelsDevSyncResult, modelsDevSyncOutcome } from './page-messages'

function modelsDevCopy(status: {
  fetched_at: string | null
  status: 'ok' | 'error' | 'never'
  error: string | null
  models: number
}): { title: string; detail: string } {
  if (status.status === 'never') {
    return {
      title: t('models:neverSynced'),
      detail: t('models:neverSyncedHint'),
    }
  }
  const when = status.fetched_at
    ? fmtAgo(status.fetched_at) || status.fetched_at
    : t('models:unknownTime')
  if (status.status === 'ok') {
    return {
      title: t('models:syncedAt', { when }),
      detail: t('models:modelCount', { count: status.models }),
    }
  }
  return {
    title: t('models:failedAt', { when }),
    detail: status.error || t('models:fetchFailedHint'),
  }
}

function DiffMark({ entry }: { entry: PricingEntry }) {
  const { t } = useTranslation('models')

  if (!entry.diff) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant='outline' className='cursor-default font-mono'>
          {t('models:difference')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs space-y-1'>
        <p>
          {t('models:builtinRates', { rates: fmtBaseRates(entry.builtin) })}
        </p>
        <p>models.dev {fmtBaseRates(entry.models_dev)}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function CatalogTable({
  title,
  rows,
  onEdit,
}: {
  title: string
  rows: PricingEntry[]
  onEdit: (entry: PricingEntry) => void
}) {
  const { t } = useTranslation('models')

  const [inPolicyOnly, setInPolicyOnly] = useState(true)
  const visible = inPolicyOnly ? rows.filter((r) => r.in_policy) : rows
  return (
    <section className='space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-lg font-semibold tracking-tight'>{title}</h3>
          <p className='text-xs text-muted-foreground'>
            {inPolicyOnly
              ? t('models:policyCount', {
                  count: visible.length,
                  total: rows.length,
                })
              : t('models:allCount', { count: visible.length })}
          </p>
        </div>
        <label className='flex items-center gap-2 text-sm'>
          <Switch checked={inPolicyOnly} onCheckedChange={setInPolicyOnly} />
          {t('models:inPolicyOnly')}
        </label>
      </div>
      {visible.length === 0 ? (
        <EmptyState reason={t('models:noFilteredModels')} />
      ) : (
        <Table density='compact'>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>{t('models:name')}</TableHead>
              <TableHead className='text-end'>
                {t('models:inputPrice')}
              </TableHead>
              <TableHead className='text-end'>
                {t('models:outputPrice')}
              </TableHead>
              <TableHead className='text-end'>
                {t('models:cacheReadPrice')}
              </TableHead>
              <TableHead className='text-end'>
                {t('models:cache5mPrice')}
              </TableHead>
              <TableHead className='text-end'>
                {t('models:cache1hPrice')}
              </TableHead>
              <TableHead>{t('models:tiers')}</TableHead>
              <TableHead>{t('models:pricingModes')}</TableHead>
              <TableHead>{t('models:source')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const price = row.effective
              return (
                <TableRow
                  key={`${row.platform}/${row.id}`}
                  className='cursor-pointer'
                  onClick={() => onEdit(row)}
                >
                  <TableCell className='font-mono text-xs'>{row.id}</TableCell>
                  <TableCell className='max-w-[10rem] truncate'>
                    {row.name || '—'}
                  </TableCell>
                  <TableCell className='text-end font-mono text-xs tabular-nums'>
                    {fmtPerM(price?.input)}
                  </TableCell>
                  <TableCell className='text-end font-mono text-xs tabular-nums'>
                    {fmtPerM(price?.output)}
                  </TableCell>
                  <TableCell className='text-end font-mono text-xs tabular-nums'>
                    {fmtPerM(price?.cache_read)}
                  </TableCell>
                  <TableCell className='text-end font-mono text-xs tabular-nums'>
                    {fmtPerM(price?.cache_5m)}
                  </TableCell>
                  <TableCell className='text-end font-mono text-xs tabular-nums'>
                    {fmtPerM(price?.cache_1h)}
                  </TableCell>
                  <TableCell className='text-xs'>
                    {tiersSummary(price)}
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap gap-1'>
                      {modeKeys(price).map((mode) => (
                        <Badge
                          key={mode}
                          variant='outline'
                          className='font-mono'
                          title={
                            row.mode_sources[mode]
                              ? `${mode} · ${priceSourceLabel(row.mode_sources[mode])}`
                              : mode
                          }
                        >
                          {mode}
                        </Badge>
                      ))}
                      {modeKeys(price).length === 0 ? (
                        <span className='text-xs text-muted-foreground'>—</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap items-center gap-1'>
                      <Badge variant={priceSourceVariant(row.source)}>
                        {priceSourceLabel(row.source)}
                      </Badge>
                      <DiffMark entry={row} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(row)
                      }}
                    >
                      {t('models:override')}
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

export function PricingTab() {
  const { t } = useTranslation('models')

  const qc = useQueryClient()
  const q = useQuery(pricingQueryOptions())
  const [edit, setEdit] = useState<PricingEntry | null>(null)
  const [repriceOpen, setRepriceOpen] = useState(false)

  const sync = useMutation({
    mutationFn: () =>
      api<ModelsDevSyncResult>('/api/panel/pricing/sync', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      const out = modelsDevSyncOutcome(data)
      if (out.ok) toast.success(out.text)
      else toast.error(out.text)
      await invalidatePricing(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const grouped = useMemo(() => {
    const models = q.data?.models || []
    return {
      anthropic: models.filter((m) => m.platform === 'anthropic'),
      openai: models.filter((m) => m.platform === 'openai'),
    }
  }, [q.data?.models])

  const modelsDev = q.data?.models_dev
  const md = modelsDev ? modelsDevCopy(modelsDev) : null
  const unpriced = q.data?.unpriced || []

  return (
    <QueryGate loading={q.isLoading} error={q.error}>
      <div className='space-y-4'>
        <section className='grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]'>
          <div className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='space-y-1'>
                <h3 className='font-semibold'>models.dev</h3>
                <p className='text-sm text-muted-foreground'>
                  {md ? `${md.title} · ${md.detail}` : '—'}
                </p>
                {modelsDev?.status === 'error' && modelsDev.error ? (
                  <p className='text-xs text-[color:var(--status-warn)]'>
                    {modelsDev.error}
                  </p>
                ) : null}
              </div>
              <Button
                variant='outline'
                className='cursor-pointer'
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending
                  ? t('models:syncing')
                  : t('models:syncModelsDev')}
              </Button>
            </div>
          </div>
          <div className='flex items-center rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
            <Button
              variant='outline'
              className='cursor-pointer'
              onClick={() => setRepriceOpen(true)}
            >
              {t('models:reprice')}
            </Button>
          </div>
        </section>

        {unpriced.length ? (
          <section className='rounded-2xl border border-[color:var(--status-caution)]/40 bg-card p-4 shadow-sm'>
            <h3 className='font-semibold'>{t('models:unpricedModels')}</h3>
            <p className='mt-1 text-xs text-muted-foreground'>
              {t('models:unpricedHint')}
            </p>
            <ul className='mt-3 space-y-1.5 text-sm'>
              {unpriced.map((row) => (
                <li
                  key={row.model}
                  className='flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs'
                >
                  <span>{row.model || t('models:empty')}</span>
                  <span className='text-muted-foreground'>
                    {t('models:requestCount', { count: row.requests })}
                    {row.last_seen
                      ? ` · ${fmtAgo(row.last_seen) || row.last_seen}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <CatalogTable
          title='Anthropic'
          rows={grouped.anthropic}
          onEdit={setEdit}
        />
        <CatalogTable title='OpenAI' rows={grouped.openai} onEdit={setEdit} />
      </div>

      <PriceOverrideDialog
        entry={edit}
        open={Boolean(edit)}
        onOpenChange={(next) => {
          if (!next) setEdit(null)
        }}
      />
      <RepriceDialog open={repriceOpen} onOpenChange={setRepriceOpen} />
    </QueryGate>
  )
}

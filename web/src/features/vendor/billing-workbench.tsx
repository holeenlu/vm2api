import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import {
  SYSTEM_TIMEZONE,
  SYSTEM_TIMEZONE_LABEL,
  systemDate,
} from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DateRangePicker,
  dateRangeValueForPreset,
} from '@/components/date-range-picker'
import { money, number, time, type Vendor } from './portal-model'
import {
  PricingBreakdown,
  type PricingLine,
  type PricingSnapshot,
} from './pricing-breakdown'
import { SettlementActions } from './settlement-actions'

type Snapshot = PricingSnapshot & {
  vendor_id?: string
  vendor_name?: string
  start_date?: string
  end_date?: string
  timezone?: string
  available_count?: number
  occupied_count?: number
  requests?: number
  cost_usd?: string | number
  subtotal_usdt?: string
  adjustment?: string
  adjustment_reason?: string
  exchange_rate?: string
  total_usdt?: string
  contract_version?: number | null
  multiplier?: string
  lines?: PricingLine[]
}
type Statement = {
  id: string
  direction: 'upstream' | 'downstream'
  counterparty_name: string | null
  period_start: string
  period_end: string
  status: string
  amount_usdt: number
  created_at: string
  contract_version: number | null
  usage: Snapshot
}
type Preview = {
  vendor_id: string
  preview_token: string
  expires_at: string
  available_count: number
  occupied_count: number
  statement: Snapshot
  idempotency_key: string
}
type Billing = { upstream: Statement[]; downstream: Statement[] }
const selectClass =
  'h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'
function dayOffset(days: number) {
  return systemDate(Date.now() + days * 86400000)
}
function amount(value: unknown) {
  const n = Number(value)
  return value == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      })
}

function precise(value: unknown) {
  if (value == null) return '—'
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value))
  if (!match) return '—'
  const decimal =
    new Intl.NumberFormat().formatToParts(1.1).find((p) => p.type === 'decimal')
      ?.value || '.'
  return (
    match[1] +
    Number(match[2]).toLocaleString() +
    decimal +
    (match[3] || '').replace(/0+$/, '').padEnd(2, '0')
  )
}
function preciseUsd(value: unknown) {
  return value == null ? '—' : '$' + precise(value)
}

export function BillingWorkbench({
  vendor,
  children,
  childrenLoading,
  childrenError,
  onManageVendors,
}: {
  vendor: Vendor
  children: Vendor[]
  childrenLoading: boolean
  childrenError: Error | null
  onManageVendors: () => void
}) {
  const { t } = useTranslation('vendor')
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['vendor', 'billing', vendor.id],
    queryFn: () => api<Billing>('/api/vendor/billing'),
  })
  const canCreate =
    vendor.tier === 1 &&
    vendor.capabilities.includes('vendor.create_child') &&
    vendor.capabilities.includes('vendor.settlement.read')
  const eligible = children.filter((v) => v.tier === 2)
  const [direction, setDirection] = useState('all')
  const [status, setStatus] = useState('all')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [previews, setPreviews] = useState<Preview[]>([])
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<Statement | null>(null)
  const epoch = useRef(0)
  const [draft, setDraft] = useState({
    vendor_ids: [] as string[],
    start_date: dayOffset(-7),
    end_date: dayOffset(-1),
    timezone: SYSTEM_TIMEZONE,
    adjustment: '0',
    adjustment_reason: '',
  })
  const change = (patch: Partial<typeof draft>) => {
    epoch.current++
    setDraft({ ...draft, ...patch })
    setPreviews([])
    setSaved({})
    setError('')
  }
  const selectPayee = (id: string, selected: boolean) => {
    const ids = selected
      ? [...draft.vendor_ids, id]
      : draft.vendor_ids.filter((v) => v !== id)
    change({ vendor_ids: ids })
  }
  const open = () => {
    epoch.current++
    setCreating(true)
    setPreviews([])
    setSaved({})
    setError('')
  }
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['vendor', 'billing'] })
  }
  const preview = async () => {
    if (busy) return
    if (!draft.vendor_ids.length) {
      setError(t('bill.selectPayees'))
      return
    }
    setBusy(true)
    setError('')
    const version = ++epoch.current
    try {
      const result = await api<{ items: Omit<Preview, 'idempotency_key'>[] }>(
        '/api/vendor/settlements/preview',
        { method: 'POST', body: JSON.stringify(draft) }
      )
      if (version !== epoch.current) return
      setPreviews(
        result.items.map((p) => ({
          ...p,
          idempotency_key: crypto.randomUUID(),
        }))
      )
      setSaved({})
    } catch (e) {
      if (version === epoch.current)
        setError(e instanceof Error ? e.message : t('settlementFailed'))
    } finally {
      setBusy(false)
    }
  }
  const generate = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      for (const p of previews.filter(
        (p) => p.available_count > 0 && !saved[p.vendor_id]
      )) {
        const item = await api<Statement>('/api/vendor/settlements', {
          method: 'POST',
          body: JSON.stringify({
            preview_token: p.preview_token,
            idempotency_key: p.idempotency_key,
          }),
        })
        setSaved((previous) => ({ ...previous, [p.vendor_id]: item.id }))
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settlementFailed'))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const items = [
    ...(query.data?.upstream || []),
    ...(query.data?.downstream || []),
  ]
    .filter(
      (item) =>
        (direction === 'all' || item.direction === direction) &&
        (status === 'all' || item.status === status)
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const period = (s: Statement) =>
    (s.usage.start_date || systemDate(s.period_start)) +
    ' — ' +
    (s.usage.end_date || systemDate(s.period_end))
  const lines = (snapshot: Snapshot) => <PricingBreakdown snapshot={snapshot} />
  return (
    <section className='space-y-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('view.billing')}
          </h1>
          <p className='mt-1 text-sm text-muted-foreground'>
            {t('bill.description')}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            variant='outline'
            onClick={() => void refresh()}
            disabled={query.isFetching}
          >
            <RefreshCw />
            {t('refresh')}
          </Button>
          {canCreate && (
            <Button onClick={open}>
              <Plus />
              {t('createSettlement')}
            </Button>
          )}
        </div>
      </div>
      {error && !creating && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      <div className='overflow-hidden rounded-xl border bg-card shadow-sm'>
        <div className='flex flex-wrap gap-2 border-b p-3'>
          <select
            className={selectClass}
            aria-label={t('bill.direction')}
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            {['all', 'upstream', 'downstream']
              .filter((key) => canCreate || key !== 'downstream')
              .map((key) => (
                <option key={key} value={key}>
                  {t('bill.directionLabel.' + key)}
                </option>
              ))}
          </select>
          <select
            className={selectClass}
            aria-label={t('statusFilter')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value='all'>{t('allStatuses')}</option>
            {[
              'draft',
              'review',
              'confirmed',
              'partial',
              'paid',
              'disputed',
              'void',
            ].map((key) => (
              <option key={key} value={key}>
                {t('bill.status.' + key)}
              </option>
            ))}
          </select>
        </div>
        {query.error ? (
          <p role='alert' className='p-6 text-sm text-destructive'>
            {query.error.message}
          </p>
        ) : query.isPending ? (
          <p className='p-8 text-center text-muted-foreground'>
            {t('loading')}
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[950px] text-sm'>
              <thead className='border-b bg-muted/30 text-xs text-muted-foreground'>
                <tr>
                  {[
                    t('statement'),
                    t('bill.direction'),
                    t('bill.counterparty'),
                    t('period'),
                    t('requests'),
                    t('bill.baseUsd'),
                    t('amountUsdt'),
                    t('status'),
                    t('actions'),
                  ].map((label) => (
                    <th
                      key={label}
                      className='px-3 py-3 text-start font-medium'
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className='divide-y'>
                {items.map((item) => (
                  <tr key={item.id} className='[&_td]:px-3 [&_td]:py-3'>
                    <td className='font-mono text-xs' title={item.id}>
                      {item.id.slice(-12)}
                    </td>
                    <td>
                      <span className='rounded-full bg-primary/10 px-2 py-1 text-xs text-primary'>
                        {t('bill.directionLabel.' + item.direction)}
                      </span>
                    </td>
                    <td>{item.counterparty_name || t('bill.platform')}</td>
                    <td className='text-xs whitespace-nowrap'>
                      {period(item)}
                      <p className='text-muted-foreground'>
                        {item.usage.timezone}
                      </p>
                    </td>
                    <td>
                      {number(
                        item.usage.available_count ?? item.usage.requests
                      )}
                    </td>
                    <td>
                      {item.usage.cost_usd == null
                        ? '—'
                        : money(Number(item.usage.cost_usd))}
                    </td>
                    <td className='font-semibold tabular-nums'>
                      {amount(item.amount_usdt)}
                    </td>
                    <td>{t('bill.status.' + item.status)}</td>
                    <td className='whitespace-nowrap'>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setDetail(item)}
                      >
                        {t('detailsButton')}
                      </Button>
                      {canCreate &&
                        vendor.capabilities.includes('vendor.settlement.pay') &&
                        item.direction === 'downstream' && (
                          <SettlementActions
                            statement={item}
                            basePath='/api/vendor/settlements'
                            onChanged={() => query.refetch()}
                          />
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && (
              <p className='p-10 text-center text-sm text-muted-foreground'>
                {t('bill.empty')}
              </p>
            )}
          </div>
        )}
      </div>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!busy) {
            setCreating(open)
            epoch.current++
          }
        }}
      >
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-4xl'>
          <DialogHeader>
            <DialogTitle>{t('createSettlement')}</DialogTitle>
            <DialogDescription>{t('bill.newDescription')}</DialogDescription>
          </DialogHeader>
          {childrenLoading ? (
            <p>{t('loading')}</p>
          ) : childrenError ? (
            <p role='alert'>{childrenError.message}</p>
          ) : !eligible.length ? (
            <div className='rounded-lg border p-5 text-sm'>
              <p>{t('bill.noPayees')}</p>
              <Button
                className='mt-3'
                variant='outline'
                onClick={() => {
                  setCreating(false)
                  onManageVendors()
                }}
              >
                {t('view.vendors')}
              </Button>
            </div>
          ) : (
            <>
              <form
                className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'
                onSubmit={(e) => {
                  e.preventDefault()
                  void preview()
                }}
              >
                <fieldset
                  className='col-span-full rounded-lg border p-3'
                  disabled={busy}
                >
                  <legend className='px-1 text-sm font-medium'>
                    {t('downstreamVendor')}
                  </legend>
                  <div className='flex max-h-32 flex-wrap gap-x-5 gap-y-2 overflow-auto'>
                    {eligible.map((v) => (
                      <label
                        className='flex items-center gap-2 text-sm'
                        key={v.id}
                      >
                        <input
                          type='checkbox'
                          checked={draft.vendor_ids.includes(v.id)}
                          onChange={(e) => selectPayee(v.id, e.target.checked)}
                        />
                        {v.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className='col-span-full grid gap-1.5 text-sm'>
                  <span>
                    {t('startDate')} / {t('endDate')}
                  </span>
                  <DateRangePicker
                    value={{
                      startDate: draft.start_date,
                      endDate: draft.end_date,
                    }}
                    disableFuture
                    allowClear={false}
                    presets={[
                      'today',
                      'yesterday',
                      '7days',
                      '30days',
                      'thisMonth',
                      'lastMonth',
                    ].map((id) => ({
                      id,
                      label: t('details.rangeLabel.' + id),
                      value: dateRangeValueForPreset(
                        id as Parameters<typeof dateRangeValueForPreset>[0]
                      ),
                    }))}
                    labels={{
                      empty: t('selectDateRange'),
                      clear: t('clear'),
                    }}
                    onChange={(value) => {
                      if (value.startDate && value.endDate)
                        change({
                          start_date: value.startDate,
                          end_date: value.endDate,
                        })
                    }}
                  />
                </div>
                <label className='grid gap-1.5 text-sm'>
                  {t('bill.timezone')}
                  <span>{SYSTEM_TIMEZONE_LABEL}</span>
                </label>
                <label className='grid gap-1.5 text-sm'>
                  {t('bill.adjustment')}
                  <Input
                    required
                    type='number'
                    step='0.000001'
                    disabled={busy}
                    value={draft.adjustment}
                    onChange={(e) => change({ adjustment: e.target.value })}
                  />
                </label>
                <label className='col-span-full grid gap-1.5 text-sm'>
                  {t('bill.adjustmentReason')}
                  <Input
                    required={Number(draft.adjustment) !== 0}
                    maxLength={1000}
                    disabled={busy}
                    value={draft.adjustment_reason}
                    onChange={(e) =>
                      change({ adjustment_reason: e.target.value })
                    }
                  />
                </label>
                <p className='col-span-full text-xs text-muted-foreground'>
                  {t('bill.formula')}
                </p>
                <div className='col-span-full flex justify-end'>
                  <Button
                    type='submit'
                    disabled={busy || !draft.vendor_ids.length}
                  >
                    <FileText />
                    {t('bill.preview')}
                  </Button>
                </div>
              </form>
              {previews.map((p) => (
                <section
                  className='space-y-3 rounded-lg border p-4'
                  key={p.vendor_id}
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <h3 className='font-semibold'>{p.statement.vendor_name}</h3>
                    <span className='text-xs text-muted-foreground'>
                      {t('bill.records', {
                        available: p.available_count,
                        occupied: p.occupied_count,
                      })}
                    </span>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    {t('supplierAdmin:pricingCalculationBasis')}
                  </p>
                  {p.available_count ? (
                    lines(p.statement)
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      {t('bill.noUsage')}
                    </p>
                  )}
                  <dl className='grid grid-cols-2 gap-3 text-sm sm:grid-cols-4'>
                    {[
                      [t('bill.baseUsd'), preciseUsd(p.statement.cost_usd)],
                      [t('bill.subtotal'), amount(p.statement.subtotal_usdt)],
                      [
                        t('bill.adjustmentShort'),
                        amount(p.statement.adjustment),
                      ],
                      [t('bill.total'), amount(p.statement.total_usdt)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className='text-xs text-muted-foreground'>
                          {label}
                        </dt>
                        <dd className='mt-1 font-semibold tabular-nums'>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className='text-xs text-muted-foreground'>
                    {t('bill.previewExpires', { time: time(p.expires_at) })}
                  </p>
                  {saved[p.vendor_id] && (
                    <p role='status' className='text-sm text-primary'>
                      {t('bill.draftCreated')}
                    </p>
                  )}
                </section>
              ))}
              {error && (
                <p role='alert' className='text-sm text-destructive'>
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => setCreating(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  disabled={
                    busy ||
                    !previews.some(
                      (p) => p.available_count > 0 && !saved[p.vendor_id]
                    )
                  }
                  onClick={() => void generate()}
                >
                  {t('bill.generateDraft')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>{t('bill.details')}</DialogTitle>
            <DialogDescription>
              {detail ? period(detail) : ''}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <dl className='grid grid-cols-2 gap-3 text-sm'>
                {[
                  [
                    t('bill.counterparty'),
                    detail.counterparty_name || t('bill.platform'),
                  ],
                  [t('amountUsdt'), amount(detail.amount_usdt)],
                  [
                    t('bill.adjustmentReason'),
                    detail.usage.adjustment_reason || '—',
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className='text-xs text-muted-foreground'>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {lines(detail.usage)}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

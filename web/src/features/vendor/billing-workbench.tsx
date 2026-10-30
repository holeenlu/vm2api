import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
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
import { money, number, time, type Vendor } from './portal-model'
import { SettlementActions } from './settlement-actions'

type Line = {
  group_id: number | null
  group_name: string
  coefficient: string
  cost_usd: string
  amount_usdt: string
  requests: number
}
type Snapshot = {
  vendor_id?: string
  vendor_name?: string
  binance_id?: string
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
  exchange_rate_source?: string
  total_usdt?: string
  contract_version?: number
  multiplier?: string
  lines?: Line[]
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
  contract_version: number
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
const selectClass = 'h-10 rounded-lg border bg-background px-3 text-sm'
function dayOffset(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
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
  const manualFx = useRef(false)
  const [draft, setDraft] = useState({
    vendor_ids: [] as string[],
    start_date: dayOffset(-7),
    end_date: dayOffset(-1),
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    exchange_rate: '',
    exchange_rate_source: t('bill.defaultFxSource'),
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
    const rates = ids.map((id) =>
      String(eligible.find((v) => v.id === id)?.fx_cny_per_usdt ?? '')
    )
    const rate =
      rates.length && rates.every((r) => r === rates[0]) ? rates[0] : ''
    change({
      vendor_ids: ids,
      ...(!manualFx.current ? { exchange_rate: rate } : {}),
    })
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
    (s.usage.start_date || s.period_start.slice(0, 10)) +
    ' — ' +
    (s.usage.end_date || s.period_end.slice(0, 10))
  const lines = (snapshot: Snapshot) => (
    <div className='overflow-x-auto'>
      <table className='w-full text-xs'>
        <thead className='bg-muted/30'>
          <tr>
            {[
              t('groups'),
              t('requests'),
              t('bill.baseUsd'),
              t('purchasePrice'),
              t('amountUsdt'),
            ].map((label) => (
              <th key={label} className='px-3 py-2 text-start'>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {snapshot.lines?.map((line, i) => (
            <tr key={i} className='border-t [&_td]:px-3 [&_td]:py-2'>
              <td>{line.group_name || t('bill.ungrouped')}</td>
              <td>{number(line.requests)}</td>
              <td>{preciseUsd(line.cost_usd)}</td>
              <td>{precise(line.coefficient)}</td>
              <td>{amount(line.amount_usdt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <section className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='text-xl font-semibold'>{t('view.billing')}</h1>
          <p className='mt-1 text-sm text-muted-foreground'>
            {t('bill.description')}
          </p>
        </div>
        <div className='flex gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void refresh()}
            disabled={query.isFetching}
          >
            <RefreshCw />
            {t('refresh')}
          </Button>
          {canCreate && (
            <Button size='sm' onClick={open}>
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
                <label className='grid gap-1.5 text-sm'>
                  {t('startDate')}
                  <Input
                    required
                    type='date'
                    disabled={busy}
                    value={draft.start_date}
                    onChange={(e) => change({ start_date: e.target.value })}
                  />
                </label>
                <label className='grid gap-1.5 text-sm'>
                  {t('endDate')}
                  <Input
                    required
                    type='date'
                    min={draft.start_date}
                    disabled={busy}
                    value={draft.end_date}
                    onChange={(e) => change({ end_date: e.target.value })}
                  />
                </label>
                <label className='grid gap-1.5 text-sm'>
                  {t('bill.timezone')}
                  <Input
                    required
                    disabled={busy}
                    value={draft.timezone}
                    onChange={(e) => change({ timezone: e.target.value })}
                  />
                </label>
                <label className='grid gap-1.5 text-sm'>
                  {t('settlementRateFull')}
                  <Input
                    required
                    type='number'
                    min='0.0000000001'
                    step='any'
                    disabled={busy}
                    value={draft.exchange_rate}
                    onChange={(e) => {
                      manualFx.current = true
                      change({ exchange_rate: e.target.value })
                    }}
                  />
                </label>
                <label className='grid gap-1.5 text-sm'>
                  {t('bill.fxSource')}
                  <Input
                    required
                    maxLength={240}
                    disabled={busy}
                    value={draft.exchange_rate_source}
                    onChange={(e) =>
                      change({ exchange_rate_source: e.target.value })
                    }
                  />
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
                    {t('bill.calculationBasis', {
                      multiplier: precise(p.statement.multiplier),
                      version: p.statement.contract_version,
                      rate: precise(p.statement.exchange_rate),
                    })}
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
                    t('settlementRateFull'),
                    precise(detail.usage.exchange_rate),
                  ],
                  [
                    t('bill.fxSource'),
                    detail.usage.exchange_rate_source || '—',
                  ],
                  [t('binanceId'), detail.usage.binance_id || '—'],
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

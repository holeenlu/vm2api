import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { exclusiveEndDate, systemDate } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { DateRangePicker } from '@/components/date-range-picker'
import { time } from '@/features/vendor/portal-model'
import { PricingBreakdown } from '@/features/vendor/pricing-breakdown'
import {
  ROOT,
  amount,
  selectClass,
  settlementEditorPresets,
  supplierQueryKeys,
  type Supplier,
  type Preview,
  type Statement,
} from './model'

export function SettlementEditor({
  suppliers,
  initialVendor,
  close,
  saved,
}: {
  suppliers: Supplier[]
  initialVendor: string
  close: () => void
  saved: () => Promise<void>
}) {
  const { t } = useTranslation('supplierAdmin')
  const today = systemDate()
  const [vendorId, setVendorId] = useState(
    suppliers.find((v) => v.id === initialVendor && v.tier === 1)?.id || ''
  )
  const [range, setRange] = useState<{ start: string; end: string } | null>(
    null
  )
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const history = useQuery({
    queryKey: supplierQueryKeys.page(
      'settlements',
      new URLSearchParams({ vendor_id: vendorId }).toString()
    ),
    queryFn: () =>
      api<Statement[]>(
        `${ROOT}/settlements?${new URLSearchParams({ vendor_id: vendorId })}`
      ),
    enabled: !!vendorId,
  })
  const settledThrough =
    (vendorId ? history.data || [] : [])
      .filter(
        (s) =>
          s.payee_vendor_id === vendorId &&
          !s.payer_vendor_id &&
          s.status !== 'void'
      )
      .map((s) => exclusiveEndDate(s.period_end))
      .sort()
      .pop() || null
  const presets = settlementEditorPresets(today, settledThrough)
  // 未手动选择时默认“上次结算后至昨天”，没有历史时默认近 7 天。
  const [start, end] = range
    ? [range.start, range.end]
    : (presets.find(([id]) => id === 'sinceLast') || presets[1]).slice(1)
  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      if (preview) {
        await api(`${ROOT}/settlements`, {
          method: 'POST',
          body: JSON.stringify({
            preview_token: preview.preview_token,
            idempotency_key: preview.idempotency_key,
          }),
        })
        await saved()
        close()
      } else {
        const result = await api<Omit<Preview, 'idempotency_key'>>(
          `${ROOT}/settlements/preview`,
          {
            method: 'POST',
            body: JSON.stringify({
              vendor_id: vendorId,
              start_date: start,
              end_date: end,
            }),
          }
        )
        setPreview({ ...result, idempotency_key: crypto.randomUUID() })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const nothing = preview ? preview.available_count === 0 : false
  const snapshot = preview?.statement
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent className='max-h-[90vh] gap-5 overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <DialogTitle>{t('createStatement')}</DialogTitle>
          <DialogDescription>{t('settlementHint')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <label className='grid gap-2 text-sm'>
            {t('supplier')}
            <select
              className={selectClass}
              value={vendorId}
              disabled={busy}
              onChange={(e) => {
                setVendorId(e.target.value)
                setRange(null)
                setPreview(null)
              }}
            >
              <option value=''>{t('selectSupplier')}</option>
              {suppliers
                .filter((v) => v.tier === 1)
                .map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </label>
          {vendorId && (
            <p className='text-sm text-muted-foreground'>
              {history.isPending
                ? t('loading')
                : settledThrough
                  ? t('settledThrough', { date: settledThrough })
                  : t('neverSettled')}
            </p>
          )}
          <div className='grid gap-2 text-sm'>
            <span>{t('period')}</span>
            <DateRangePicker
              value={{ startDate: start, endDate: end }}
              disableFuture
              allowClear={false}
              presets={presets.map(([id, from, to]) => ({
                id,
                label: t('range.' + id),
                value: { startDate: from, endDate: to },
              }))}
              labels={{
                empty: t('selectDateRange'),
                clear: t('clear'),
              }}
              onChange={(value) => {
                if (value.startDate && value.endDate) {
                  setRange({ start: value.startDate, end: value.endDate })
                  setPreview(null)
                }
              }}
            />
            <p className='text-xs text-muted-foreground'>{t('dateHint')}</p>
          </div>
          {preview && snapshot && (
            <section className='space-y-4 rounded-lg border bg-muted/20 p-4'>
              <dl className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                {[
                  [t('availableRequests'), amount(preview.available_count)],
                  [t('occupiedRequests'), amount(preview.occupied_count)],
                  [t('costUsd'), amount(Number(snapshot.cost_usd))],
                  [t('totalUsdt'), amount(Number(snapshot.total_usdt))],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className='rounded-lg border bg-background p-3'
                  >
                    <dt className='text-xs text-muted-foreground'>{label}</dt>
                    <dd className='mt-1 text-lg font-semibold tabular-nums'>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              {preview.overlaps.length > 0 && (
                <div
                  role='status'
                  className='rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm'
                >
                  <p>
                    {t(nothing ? 'nothingToSettle' : 'overlapWarning', {
                      count: preview.available_count,
                    })}
                  </p>
                  <ul className='mt-2 space-y-1 text-xs text-muted-foreground'>
                    {preview.overlaps.map((o) => (
                      <li key={o.id}>
                        {systemDate(o.period_start)} →{' '}
                        {exclusiveEndDate(o.period_end)} ·{' '}
                        {t(`status_${o.status}`)} ·{' '}
                        {t('paymentValue', { value: amount(o.amount_usdt) })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {nothing && !preview.overlaps.length && (
                <p role='status' className='text-sm text-muted-foreground'>
                  {t('noUsageInRange')}
                </p>
              )}
              {!nothing && (
                <>
                  <p className='text-xs text-muted-foreground'>
                    {t('pricingCalculationBasis')}
                  </p>
                  <PricingBreakdown snapshot={snapshot} />
                  <p className='text-xs text-muted-foreground'>
                    {t('previewExpires', { time: time(preview.expires_at) })}
                  </p>
                </>
              )}
            </section>
          )}
          {error && (
            <p role='alert' className='text-sm text-destructive'>
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          {preview && (
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              {t('repreview')}
            </Button>
          )}
          <Button
            disabled={busy || !vendorId || !start || !end || nothing}
            onClick={() => void submit()}
          >
            {t(preview ? 'createStatement' : 'preview')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const statusTone: Record<string, string> = {
  draft: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  review: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  confirmed: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  partial: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  paid: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  disputed: 'bg-destructive/10 text-destructive',
  void: 'bg-muted text-muted-foreground',
}

export function SettlementDetail({
  statement,
  close,
}: {
  statement: Statement
  close: () => void
}) {
  const { t } = useTranslation('supplierAdmin')
  const usage = statement.usage.usage || statement.usage
  const outstanding = Math.max(
    0,
    Math.round((statement.amount_usdt - statement.paid_usdt) * 1e6) / 1e6
  )
  const metrics = [
    [t('requests'), amount(usage.requests)],
    [t('costUsd'), amount(usage.cost_usd)],
    [t('totalUsdt'), amount(statement.amount_usdt)],
    [t('paidUsdt'), amount(statement.paid_usdt)],
    [t('outstanding'), amount(outstanding)],
  ]
  const meta = [
    [t('statementId'), statement.id],
    [
      t('payer'),
      t(statement.payer_vendor_id ? 'downstream' : 'platformPayment'),
    ],
    [t('createdAt'), statement.created_at ? time(statement.created_at) : '—'],
    [
      t('confirmedAt'),
      statement.confirmed_at ? time(statement.confirmed_at) : '—',
    ],
  ]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className='max-h-[90vh] gap-5 overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <div className='flex flex-wrap items-center gap-2 pe-8'>
            <DialogTitle>{t('statementDetails')}</DialogTitle>
            <span
              className={
                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                (statusTone[statement.status] || statusTone.void)
              }
            >
              {t(`status_${statement.status}`)}
            </span>
          </div>
          <DialogDescription>
            {statement.vendor_name} · {systemDate(statement.period_start)} →{' '}
            {exclusiveEndDate(statement.period_end)}
          </DialogDescription>
        </DialogHeader>
        <dl className='grid grid-cols-2 gap-3 sm:grid-cols-5'>
          {metrics.map(([label, value], index) => (
            <div
              key={label}
              className={
                'rounded-lg border p-3 ' +
                (index === metrics.length - 1 && outstanding > 0
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'bg-muted/20')
              }
            >
              <dt className='text-xs text-muted-foreground'>{label}</dt>
              <dd className='mt-1 text-lg font-semibold break-all tabular-nums'>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <dl className='grid gap-x-6 gap-y-3 rounded-lg border p-4 text-sm sm:grid-cols-2'>
          {meta.map(([label, value], index) => (
            <div key={label} className='flex min-w-0 gap-3'>
              <dt className='w-20 shrink-0 text-muted-foreground'>{label}</dt>
              <dd
                className={
                  'min-w-0 break-all ' +
                  (index === 0 ? 'font-mono text-xs leading-5' : '')
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <section className='space-y-2'>
          <h3 className='text-sm font-semibold'>{t('pricingBreakdown')}</h3>
          <p className='text-xs text-muted-foreground'>
            {t('pricingCalculationBasis')}
          </p>
          <PricingBreakdown snapshot={statement.usage} />
        </section>
        <section className='space-y-2'>
          <h3 className='text-sm font-semibold'>
            {t('paymentHistory')}
            {statement.payments?.length ? (
              <span className='ms-2 text-xs font-normal text-muted-foreground'>
                {t('results', { count: statement.payments.length })}
              </span>
            ) : null}
          </h3>
          {statement.payments?.length ? (
            <div className='overflow-x-auto rounded-lg border'>
              <table className='w-full min-w-[560px] text-sm'>
                <thead className='bg-muted/20 text-xs text-muted-foreground'>
                  <tr className='[&_th]:px-3 [&_th]:py-2 [&_th]:font-medium'>
                    <th className='text-start'>{t('paymentTime')}</th>
                    <th className='text-end'>{t('paidUsdt')}</th>
                    <th className='text-start'>{t('paymentReference')}</th>
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {statement.payments.map((p) => (
                    <tr key={p.id} className='[&_td]:px-3 [&_td]:py-2'>
                      <td className='text-xs whitespace-nowrap'>
                        {time(p.created_at)}
                      </td>
                      <td className='text-end font-semibold tabular-nums'>
                        {amount(p.amount_usdt)}
                      </td>
                      <td className='break-all text-muted-foreground'>
                        {p.reason || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className='rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground'>
              {t('noPayments')}
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}

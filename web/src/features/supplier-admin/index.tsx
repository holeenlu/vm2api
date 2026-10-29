import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'
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
import { PageHeader } from '@/components/page-header'
import { groupsQueryOptions } from '@/features/groups/queries'
import { stateLabel } from '@/features/vendor/portal-model'
import { SupplierEditor, ResourceEditor } from './editors'
import {
  ROOT,
  amount,
  selectClass,
  type Supplier,
  type SupplierPage,
  type SupplierResource,
  type Statement,
  type Usage,
} from './model'
import { SettlementEditor } from './settlements'

export function SupplierAdminPage({
  page,
  initialVendor = 'all',
}: {
  page: SupplierPage
  initialVendor?: string
}) {
  const { t } = useTranslation('supplierAdmin')
  const qc = useQueryClient(),
    navigate = useNavigate()
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [vendorId, setVendorId] = useState(initialVendor)
  const [current, setCurrent] = useState(1)
  const [start, setStart] = useState(
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  )
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10))
  const [editor, setEditor] = useState<Supplier | 'new' | null>(null)
  const [resourceEditor, setResourceEditor] = useState(false),
    [settlementEditor, setSettlementEditor] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [action, setAction] = useState<{
    title: string
    path: string
    method: string
    body: Record<string, unknown>
  } | null>(null)
  const [detail, setDetail] = useState<Statement | null>(null)
  const [actionReason, setActionReason] = useState('')
  const [actionName, setActionName] = useState('')
  const [payment, setPayment] = useState<Statement | null>(null),
    [payAmount, setPayAmount] = useState(''),
    [reason, setReason] = useState(''),
    [paymentKey, setPaymentKey] = useState('')
  const suppliers = useQuery({
    queryKey: ['supplier-admin', 'suppliers'],
    queryFn: () => api<Supplier[]>(ROOT),
    refetchInterval: 15000,
  })
  const groups = useQuery(groupsQueryOptions())
  const params = new URLSearchParams({ vendor_id: vendorId })
  if (page === 'usage') {
    params.set('start_date', start)
    params.set('end_date', end)
  }
  const queryString = params.toString()
  const list = useQuery({
    queryKey: ['supplier-admin', page, queryString],
    queryFn: () =>
      api<SupplierResource[] | Statement[] | Usage>(
        `${ROOT}/${page}?${queryString}`
      ),
    enabled: page !== 'suppliers',
    refetchInterval: 15000,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['supplier-admin'] }),
      qc.invalidateQueries({ queryKey: ['vendor'] }),
      qc.invalidateQueries({ queryKey: ['panel', 'providers'] }),
      qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ])
  }
  const mutate = async (
    path: string,
    method: string,
    body: Record<string, unknown>
  ) => {
    setError('')
    setBusy(true)
    try {
      await api(path, { method, body: JSON.stringify(body) })
      await refresh()
      setAction(null)
      setPayment(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const supplierName = (id: string) =>
    suppliers.data?.find((v) => v.id === id)?.name || id
  const openTab = (target: SupplierPage, id: string) => {
    setVendorId(id)
    setCurrent(1)
    void navigate({
      to: '/suppliers/$page',
      params: { page: target },
      search: { vendor_id: id },
    })
  }
  const filter = <T extends { status?: string }>(
    rows: T[],
    label: (row: T) => string
  ) =>
    rows.filter(
      (r) =>
        (status === 'all' || r.status === status) &&
        label(r).toLowerCase().includes(search.toLowerCase())
    )
  const vendors = filter(suppliers.data || [], (v) =>
    [
      v.name,
      v.email,
      v.external_code,
      ...v.members.map((m) => m.username),
    ].join(' ')
  )
  const resources = filter(
    Array.isArray(list.data) ? (list.data as SupplierResource[]) : [],
    (r) => `${r.name} ${supplierName(r.vendor_id)}`
  )
  const statements = filter(
    Array.isArray(list.data) ? (list.data as Statement[]) : [],
    (r) => `${r.vendor_name} ${r.id}`
  )
  const platformStatements = statements.filter(
    (s) => !s.payer_vendor_id && s.status !== 'void'
  )
  const usage =
    page === 'usage' && list.data && !Array.isArray(list.data)
      ? list.data
      : undefined
  const count =
    page === 'suppliers'
      ? vendors.length
      : page === 'usage'
        ? usage?.accounts.length || 0
        : page === 'settlements'
          ? statements.length
          : resources.length
  const pageCount = Math.max(1, Math.ceil(count / 20)),
    safePage = Math.min(current, pageCount)
  const slice = <T,>(rows: T[]) =>
    rows.slice((safePage - 1) * 20, safePage * 20)
  const actionButton = (
    title: string,
    path: string,
    method: string,
    body: Record<string, unknown>
  ) => (
    <Button
      size='sm'
      variant='outline'
      onClick={() => {
        setError('')
        setActionName(String(body.name || ''))
        setActionReason('')
        setAction({ title, path, method, body })
      }}
    >
      {title}
    </Button>
  )
  const table = (headers: string[], body: ReactNode) => (
    <div className='overflow-x-auto rounded-xl border bg-card'>
      <table className='w-full min-w-[1100px] text-sm [&_td]:whitespace-nowrap'>
        <thead className='border-b bg-muted/40'>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className='px-4 py-3 text-left font-medium whitespace-nowrap text-muted-foreground'
              >
                {t(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y'>{body}</tbody>
      </table>
    </div>
  )
  const metrics =
    page === 'suppliers'
      ? [
          [t('supplierCount'), suppliers.data?.length || 0],
          [
            t('activeSuppliers'),
            suppliers.data?.filter((v) => v.status === 'active').length || 0,
          ],
          [
            t('accounts'),
            (suppliers.data || [])
              .filter((v) => v.tier === 1)
              .reduce((n, v) => n + v.account_count, 0),
          ],
          [
            t('proxies'),
            (suppliers.data || [])
              .filter((v) => v.tier === 1)
              .reduce((n, v) => n + v.proxy_count, 0),
          ],
        ]
      : page === 'usage'
        ? [
            [t('requests'), usage?.summary.requests || 0],
            [t('inputTokens'), usage?.summary.input_tokens || 0],
            [t('outputTokens'), usage?.summary.output_tokens || 0],
            [t('costUsd'), usage?.summary.cost_usd || 0],
          ]
        : page === 'settlements'
          ? [
              [t('platformStatementCount'), platformStatements.length],
              [
                t('totalUsdt'),
                platformStatements.reduce((n, s) => n + s.amount_usdt, 0),
              ],
              [
                t('paidUsdt'),
                platformStatements.reduce((n, s) => n + s.paid_usdt, 0),
              ],
              [
                t('outstanding'),
                platformStatements.reduce(
                  (n, s) => n + Math.max(0, s.amount_usdt - s.paid_usdt),
                  0
                ),
              ],
            ]
          : []
  return (
    <PageHeader
      title={t(page)}
      description={t(`${page}Description`)}
      fluid
      extra={
        <div className='flex gap-2'>
          <Button
            variant='outline'
            onClick={() => void refresh()}
            aria-label={t('refresh')}
          >
            <RefreshCw className='size-4' />
          </Button>
          {page !== 'usage' && (
            <Button
              onClick={() =>
                page === 'suppliers'
                  ? setEditor('new')
                  : page === 'settlements'
                    ? setSettlementEditor(true)
                    : setResourceEditor(true)
              }
            >
              <Plus className='size-4' />
              {t('add')}
            </Button>
          )}
        </div>
      }
    >
      <div className='space-y-5'>
        {page === 'usage' && !!usage?.summary.unpriced_requests && (
          <p role='alert' className='text-sm text-amber-600'>
            {t('unpricedWarning', { count: usage.summary.unpriced_requests })}
          </p>
        )}
        {!!metrics.length && (
          <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
            {metrics.map(([label, value]) => (
              <div
                key={String(label)}
                className='rounded-xl border bg-card p-5'
              >
                <div className='text-sm text-muted-foreground'>{label}</div>
                <div className='mt-2 text-2xl font-semibold tabular-nums'>
                  {typeof value === 'number' ? amount(value) : value}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className='flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4'>
          {page !== 'suppliers' && (
            <select
              className={selectClass}
              aria-label={t('supplier')}
              value={vendorId}
              onChange={(e) => {
                setVendorId(e.target.value)
                setCurrent(1)
              }}
            >
              <option value='all'>{t('allSuppliers')}</option>
              {suppliers.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
          {page === 'usage' ? (
            <>
              <label className='flex items-center gap-2 text-sm'>
                {t('startDate')}
                <Input
                  type='date'
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className='flex items-center gap-2 text-sm'>
                {t('endDate')}
                <Input
                  type='date'
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <span className='text-xs text-muted-foreground'>
                {t('dateHint')}
              </span>
            </>
          ) : (
            <>
              <Input
                className='max-w-sm flex-1'
                placeholder={t('search')}
                aria-label={t('search')}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setCurrent(1)
                }}
              />
              <select
                className={selectClass}
                aria-label={t('status')}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value)
                  setCurrent(1)
                }}
              >
                <option value='all'>{t('allStatuses')}</option>
                {(page === 'settlements'
                  ? ['review', 'confirmed', 'partial', 'paid', 'void']
                  : page === 'suppliers'
                    ? ['active', 'disabled', 'archived']
                    : ['active', 'paused', 'provisioning']
                ).map((s) => (
                  <option key={s} value={s}>
                    {t(`status_${s}`)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {(error || suppliers.error || list.error) && (
          <p role='alert' className='text-sm text-destructive'>
            {error || suppliers.error?.message || list.error?.message}
          </p>
        )}
        {suppliers.isPending || (page !== 'suppliers' && list.isPending) ? (
          <p className='p-8 text-muted-foreground'>{t('loading')}</p>
        ) : (
          <>
            {page === 'suppliers' &&
              table(
                [
                  'name',
                  'status',
                  'tier',
                  'platforms',
                  'groups',
                  'accounts',
                  'proxies',
                  'contact',
                  'binance',
                  'actions',
                ],
                slice(vendors).map((v) => (
                  <tr key={v.id} className='align-top hover:bg-muted/20'>
                    <td className='p-4'>
                      <button
                        className='font-medium text-primary'
                        onClick={() => setEditor(v)}
                      >
                        {v.name}
                      </button>
                      <div className='mt-1 text-xs text-muted-foreground'>
                        {v.members.map((m) => m.username).join(', ') || '—'}
                      </div>
                    </td>
                    <td className='p-4'>{t(`status_${v.status}`)}</td>
                    <td className='p-4'>
                      {t(v.tier === 1 ? 'tier1' : 'tier2')}
                      {v.parent_id && (
                        <div className='text-xs text-muted-foreground'>
                          {supplierName(v.parent_id)}
                        </div>
                      )}
                    </td>
                    <td className='p-4'>
                      {v.platforms?.join(' · ') || t('all')}
                    </td>
                    <td className='p-4'>
                      {v.groups
                        ?.map(
                          (id) =>
                            groups.data?.items.find((g) => String(g.id) === id)
                              ?.name || id
                        )
                        .join(' · ') || t('defaultGroups')}
                    </td>
                    <td className='p-4 tabular-nums'>
                      {v.account_count} / {v.account_limit || t('unlimited')}
                    </td>
                    <td className='p-4 tabular-nums'>
                      {v.proxy_count} / {v.proxy_limit || t('unlimited')}
                    </td>
                    <td className='p-4'>{v.contact_name || '—'}</td>
                    <td className='p-4'>{v.binance_id || '—'}</td>
                    <td className='p-4'>
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => setEditor(v)}
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => openTab('accounts', v.id)}
                        >
                          {t('accounts')}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => openTab('usage', v.id)}
                        >
                          {t('usage')}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => openTab('settlements', v.id)}
                        >
                          {t('settlements')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            {(page === 'accounts' || page === 'proxies') &&
              table(
                [
                  'name',
                  'supplier',
                  'status',
                  ...(page === 'accounts'
                    ? ['quota', 'costUsd', 'tokens']
                    : ['endpoint', 'platforms']),
                  'actions',
                ],
                slice(resources).map((r) => (
                  <tr key={r.id} className='align-top hover:bg-muted/20'>
                    <td className='p-4 font-medium'>
                      {r.name}
                      <div className='mt-1 text-xs font-normal text-muted-foreground'>
                        {r.telemetry?.email || r.id}
                      </div>
                    </td>
                    <td className='p-4'>{supplierName(r.vendor_id)}</td>
                    <td className='p-4'>
                      {r.telemetry
                        ? stateLabel(r.telemetry.state)
                        : t(`status_${r.status}`)}
                    </td>
                    {page === 'accounts' ? (
                      <>
                        <td className='space-y-2 p-4'>
                          {(['5h', '7d'] as const).map((w) => (
                            <div key={w} className='flex items-center gap-2'>
                              <span>{w.toUpperCase()}</span>
                              <span className='tabular-nums'>
                                {r.telemetry?.[`utilization_${w}`] == null
                                  ? '—'
                                  : `${(Number(r.telemetry[`utilization_${w}`]) * 100).toFixed(1)}%`}
                              </span>
                            </div>
                          ))}
                        </td>
                        <td className='p-4 tabular-nums'>
                          {r.telemetry?.total_cost == null
                            ? '—'
                            : `$${amount(r.telemetry.total_cost)}`}
                        </td>
                        <td className='p-4 tabular-nums'>
                          {r.telemetry?.total_tokens == null
                            ? '—'
                            : amount(r.telemetry.total_tokens)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className='p-4'>
                          {String(r.config.endpoint || '—')}
                        </td>
                        <td className='p-4'>
                          {Array.isArray(r.config.platforms)
                            ? r.config.platforms.join(' · ') || t('all')
                            : '—'}
                        </td>
                      </>
                    )}
                    <td className='p-4'>
                      <div className='flex flex-wrap gap-2'>
                        {actionButton(
                          t('rename'),
                          `${ROOT}/${page}/${r.id}`,
                          'PATCH',
                          { name: r.name }
                        )}
                        {actionButton(
                          t(r.status === 'paused' ? 'resume' : 'pause'),
                          `${ROOT}/${page}/${r.id}`,
                          'PATCH',
                          {
                            status: r.status === 'paused' ? 'active' : 'paused',
                          }
                        )}
                        {actionButton(
                          t('archive'),
                          `${ROOT}/${page}/${r.id}`,
                          'DELETE',
                          {}
                        )}
                        {r.telemetry?.vm_id && (
                          <Button size='sm' variant='outline' asChild>
                            <Link
                              to='/vm/$id'
                              params={{ id: r.telemetry.vm_id }}
                            >
                              {t('vmDetails')}
                            </Link>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            {page === 'usage' && (
              <>
                {table(
                  [
                    'supplier',
                    'account',
                    'model',
                    'requests',
                    'inputTokens',
                    'outputTokens',
                    'costUsd',
                  ],
                  slice(usage?.accounts || []).map((r, i) => (
                    <tr key={i}>
                      <td className='p-4'>{r.vendor_name}</td>
                      <td className='p-4'>{r.account_name || r.resource_id}</td>
                      <td className='p-4'>{r.model || '—'}</td>
                      <td className='p-4'>{amount(r.requests)}</td>
                      <td className='p-4'>{amount(r.input_tokens)}</td>
                      <td className='p-4'>{amount(r.output_tokens)}</td>
                      <td className='p-4'>${amount(r.cost_usd)}</td>
                    </tr>
                  ))
                )}
                <h3 className='font-semibold'>{t('dailyUsage')}</h3>
                {table(
                  ['date', 'requests', 'tokens', 'costUsd'],
                  (usage?.trend || []).map((r) => (
                    <tr key={r.date}>
                      <td className='p-4'>{r.date}</td>
                      <td className='p-4'>{amount(r.requests)}</td>
                      <td className='p-4'>
                        {amount(r.input_tokens + r.output_tokens)}
                      </td>
                      <td className='p-4'>${amount(r.cost_usd)}</td>
                    </tr>
                  ))
                )}
              </>
            )}
            {page === 'settlements' &&
              table(
                [
                  'supplier',
                  'period',
                  'status',
                  'contract',
                  'totalUsdt',
                  'paidUsdt',
                  'actions',
                ],
                slice(statements).map((s) => (
                  <tr key={s.id} className='align-top'>
                    <td className='p-4 font-medium'>
                      {s.vendor_name}
                      <div className='text-xs text-muted-foreground'>
                        {t(
                          s.payer_vendor_id ? 'downstream' : 'platformPayment'
                        )}
                      </div>
                    </td>
                    <td className='p-4 text-xs'>
                      {s.period_start.slice(0, 10)} →{' '}
                      {s.period_end.slice(0, 10)}
                    </td>
                    <td className='p-4'>{t(`status_${s.status}`)}</td>
                    <td className='p-4'>
                      v{s.contract_version}
                      <div className='text-xs text-muted-foreground'>
                        {s.price_cny_per_usd} × {s.multiplier} ÷{' '}
                        {s.fx_cny_per_usdt}
                      </div>
                    </td>
                    <td className='p-4 tabular-nums'>
                      {amount(s.amount_usdt)}
                    </td>
                    <td className='p-4 tabular-nums'>{amount(s.paid_usdt)}</td>
                    <td className='p-4'>
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => setDetail(s)}
                        >
                          {t('details')}
                        </Button>
                        {!s.payer_vendor_id &&
                          ['review', 'confirmed'].includes(s.status) &&
                          actionButton(
                            t('voidStatement'),
                            `${ROOT}/settlements/${s.id}/void`,
                            'POST',
                            {}
                          )}
                        {!s.payer_vendor_id &&
                          s.status === 'review' &&
                          actionButton(
                            t('confirmStatement'),
                            `${ROOT}/settlements/${s.id}/confirm`,
                            'POST',
                            {}
                          )}
                        {!s.payer_vendor_id &&
                          ['confirmed', 'partial'].includes(s.status) && (
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => {
                                setPayment(s)
                                setPayAmount(
                                  String(
                                    Math.max(0, s.amount_usdt - s.paid_usdt)
                                  )
                                )
                                setReason('')
                                setPaymentKey(crypto.randomUUID())
                                setError('')
                              }}
                            >
                              {t('recordPayment')}
                            </Button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            {!count && (
              <p className='py-10 text-center text-muted-foreground'>
                {t('empty')}
              </p>
            )}
            <div className='flex items-center justify-between text-sm text-muted-foreground'>
              <span>{t('results', { count })}</span>
              <div className='flex items-center gap-3'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={safePage <= 1}
                  onClick={() => setCurrent(safePage - 1)}
                >
                  {t('previous')}
                </Button>
                {safePage} / {pageCount}
                <Button
                  size='sm'
                  variant='outline'
                  disabled={safePage >= pageCount}
                  onClick={() => setCurrent(safePage + 1)}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
      {editor && (
        <SupplierEditor
          supplier={editor === 'new' ? undefined : editor}
          groups={groups.data?.items || []}
          close={() => setEditor(null)}
          saved={refresh}
        />
      )}
      {resourceEditor && (page === 'accounts' || page === 'proxies') && (
        <ResourceEditor
          kind={page}
          suppliers={suppliers.data || []}
          initialVendor={vendorId}
          close={() => setResourceEditor(false)}
          saved={refresh}
        />
      )}
      {settlementEditor && (
        <SettlementEditor
          suppliers={suppliers.data || []}
          initialVendor={vendorId}
          close={() => setSettlementEditor(false)}
          saved={refresh}
        />
      )}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action?.title}</DialogTitle>
            <DialogDescription>{t('confirmAction')}</DialogDescription>
          </DialogHeader>
          {action && 'name' in action.body && (
            <label className='grid gap-2 text-sm'>
              {t('name')}
              <Input
                value={actionName}
                onChange={(e) => setActionName(e.target.value)}
              />
            </label>
          )}
          {action?.path.endsWith('/void') && (
            <label className='grid gap-2 text-sm'>
              {t('voidReason')}
              <Input
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p role='alert' className='text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => setAction(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action &&
                void mutate(
                  action.path,
                  action.method,
                  action.path.endsWith('/void')
                    ? { reason: actionReason }
                    : 'name' in action.body
                      ? { name: actionName }
                      : action.body
                )
              }
            >
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <DialogContent className='max-h-[85vh] overflow-auto'>
          <DialogHeader>
            <DialogTitle>{t('details')}</DialogTitle>
            <DialogDescription>
              {detail?.vendor_name} · {detail?.period_start.slice(0, 10)} →{' '}
              {detail?.period_end.slice(0, 10)}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <div className='grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm'>
                <div>
                  {t('requests')}:{' '}
                  {amount(
                    ('usage' in detail.usage
                      ? detail.usage.usage
                      : detail.usage
                    ).requests
                  )}
                </div>
                <div>
                  {t('costUsd')}:{' '}
                  {amount(
                    ('usage' in detail.usage
                      ? detail.usage.usage
                      : detail.usage
                    ).cost_usd
                  )}
                </div>
                <div>
                  {t('totalUsdt')}: {amount(detail.amount_usdt)}
                </div>
                <div>
                  {t('paidUsdt')}: {amount(detail.paid_usdt)}
                </div>
              </div>
              <h3 className='font-medium'>{t('paymentHistory')}</h3>
              {detail.payments?.length ? (
                detail.payments.map((p) => (
                  <div key={p.id} className='rounded-lg border p-3 text-sm'>
                    <div>
                      {t('paymentValue', { value: amount(p.amount_usdt) })}
                    </div>
                    <div className='mt-1 text-muted-foreground'>{p.reason}</div>
                    <time className='text-xs'>{p.created_at}</time>
                  </div>
                ))
              ) : (
                <p className='text-sm text-muted-foreground'>{t('empty')}</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!payment}
        onOpenChange={(open) => {
          if (!open && !busy) setPayment(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('recordPayment')}</DialogTitle>
            <DialogDescription>{t('paymentHint')}</DialogDescription>
          </DialogHeader>
          <label className='space-y-2'>
            {t('paymentAmount')}
            <Input
              type='number'
              min='0.000001'
              step='0.000001'
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </label>
          <label className='space-y-2'>
            {t('paymentReference')}
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && (
            <p role='alert' className='text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={busy || !reason || Number(payAmount) <= 0}
              onClick={() =>
                payment &&
                void mutate(
                  `${ROOT}/settlements/${payment.id}/payments`,
                  'POST',
                  {
                    amount_usdt: Number(payAmount),
                    reason,
                    idempotency_key: paymentKey,
                  }
                )
              }
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageHeader>
  )
}

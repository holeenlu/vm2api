import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { systemDate } from '@/lib/system-time'
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
import { DateRangePicker } from '@/components/date-range-picker'
import { PageHeader } from '@/components/page-header'
import { groupsQueryOptions } from '@/features/groups/queries'
import { stateLabel } from '@/features/vendor/portal-model'
import { PricingBreakdown } from '@/features/vendor/pricing-breakdown'
import { SettlementActions } from '@/features/vendor/settlement-actions'
import {
  UsageSummaryCards,
  UsageMetricCells,
} from '@/features/vendor/usage-metrics'
import { AdminAccountWorkbench } from './account-workbench'
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
import { SupplierPricingPage } from './pricing'
import { SupplierProxyWorkbench } from './proxy-workbench'
import { SettlementEditor } from './settlements'
import { supplierUsagePreset, supplierUsageQueryString } from './usage-range'

export function SupplierAdminPage({
  page,
  initialVendor = 'all',
}: {
  page: SupplierPage
  initialVendor?: string
}) {
  if (page === 'pricing') return <SupplierPricingPage />
  if (page === 'proxies')
    return (
      <SupplierProxyWorkbench suppliers={[]} initialVendor={initialVendor} />
    )
  return page === 'accounts' ? (
    <AdminAccountWorkbench initialVendor={initialVendor} />
  ) : (
    <SupplierOperationsPage page={page} initialVendor={initialVendor} />
  )
}

function SupplierOperationsPage({
  page,
  initialVendor = 'all',
}: {
  page: Exclude<SupplierPage, 'accounts' | 'pricing'>
  initialVendor?: string
}) {
  const { t } = useTranslation('supplierAdmin')
  const qc = useQueryClient(),
    navigate = useNavigate()
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [vendorId, setVendorId] = useState(initialVendor)
  const [current, setCurrent] = useState(1)
  const [{ startDate: start, endDate: end }, setUsageRange] = useState(() =>
    supplierUsagePreset('7days')
  )
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
  const [actionName, setActionName] = useState('')
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
        `${ROOT}/${page}?${page === 'usage' ? supplierUsageQueryString(queryString) : queryString}`
      ),
    enabled: page !== 'suppliers',
    refetchInterval: 15000,
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['supplier-admin'] }),
      qc.invalidateQueries({ queryKey: ['vendor'] }),
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
    [v.name, ...v.members.map((m) => m.username)].join(' ')
  )
  const allResources = Array.isArray(list.data)
    ? (list.data as SupplierResource[])
    : []
  const resources = filter(
    allResources,
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
                className={`px-4 py-3 font-medium whitespace-nowrap text-muted-foreground ${page === 'usage' && ['requests', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'cacheHitRate', 'costUsd'].includes(h) ? 'text-end' : 'text-left'}`}
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
        ? []
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
        {page === 'usage' && usage && (
          <>
            <UsageSummaryCards usage={usage.summary} />
            <p className='text-xs text-muted-foreground'>
              {t('vendor:details.cacheEvidence')}
            </p>
          </>
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
              <DateRangePicker
                value={{ startDate: start, endDate: end }}
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
                  label: t('range.' + id),
                  value: supplierUsagePreset(
                    id as Parameters<typeof supplierUsagePreset>[0]
                  ),
                }))}
                labels={{
                  empty: t('selectDateRange'),
                  clear: t('clear'),
                }}
                onChange={(value) => {
                  if (value.startDate && value.endDate) {
                    setUsageRange({
                      startDate: value.startDate,
                      endDate: value.endDate,
                    })
                    setCurrent(1)
                  }
                }}
              />
              <span className='text-xs text-muted-foreground'>
                {t('usageDateHint')}
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
            {page === 'proxies' &&
              table(
                [
                  'name',
                  'supplier',
                  'status',
                  'endpoint',
                  'platforms',
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
                    <td className='p-4'>{String(r.config.endpoint || '—')}</td>
                    <td className='p-4'>
                      {Array.isArray(r.config.platforms)
                        ? r.config.platforms.join(' · ') || t('all')
                        : '—'}
                    </td>
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
                    'cacheRead',
                    'cacheWrite',
                    'cacheHitRate',
                    'costUsd',
                  ],
                  slice(usage?.accounts || []).map((r, i) => (
                    <tr key={i}>
                      <td className='p-4'>{r.vendor_name}</td>
                      <td className='p-4'>{r.account_name || r.resource_id}</td>
                      <td className='p-4'>{r.model || '—'}</td>
                      <UsageMetricCells usage={r} />
                    </tr>
                  ))
                )}
                <h3 className='font-semibold'>{t('dailyUsage')}</h3>
                {table(
                  [
                    'date',
                    'requests',
                    'inputTokens',
                    'outputTokens',
                    'cacheRead',
                    'cacheWrite',
                    'cacheHitRate',
                    'costUsd',
                  ],
                  (usage?.trend || []).map((r) => (
                    <tr key={r.date}>
                      <td className='p-4'>{r.date}</td>
                      <UsageMetricCells usage={r} />
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
                  'pricingVersion',
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
                      {systemDate(s.period_start)} → {systemDate(s.period_end)}
                    </td>
                    <td className='p-4'>{t(`status_${s.status}`)}</td>
                    <td className='p-4'>
                      {s.usage.pricing_versions?.length
                        ? t('pricingVersionCount', {
                            versions: s.usage.pricing_versions.length,
                          })
                        : t('pricingLegacy')}
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
                        {!s.payer_vendor_id && (
                          <SettlementActions
                            statement={s}
                            basePath={`${ROOT}/settlements`}
                            onChanged={refresh}
                          />
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
      {resourceEditor && page === 'proxies' && (
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
                  'name' in action.body ? { name: actionName } : action.body
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
              {detail?.vendor_name} ·{' '}
              {detail ? systemDate(detail.period_start) : ''} →{' '}
              {detail ? systemDate(detail.period_end) : ''}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <div className='grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm'>
                <div>
                  {t('requests')}:{' '}
                  {amount((detail.usage.usage || detail.usage).requests)}
                </div>
                <div>
                  {t('costUsd')}:{' '}
                  {amount((detail.usage.usage || detail.usage).cost_usd)}
                </div>
                <div>
                  {t('totalUsdt')}: {amount(detail.amount_usdt)}
                </div>
                <div>
                  {t('paidUsdt')}: {amount(detail.paid_usdt)}
                </div>
              </div>
              <PricingBreakdown snapshot={detail.usage} />
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
    </PageHeader>
  )
}

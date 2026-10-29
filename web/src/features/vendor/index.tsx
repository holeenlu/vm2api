import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { redirect, useNavigate, useParams } from '@tanstack/react-router'
import { t as translate } from '@/i18n'
import {
  BarChart3,
  ChevronLeft,
  FileText,
  Globe2,
  LayoutGrid,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { hasSession, clearSession } from '@/lib/session'
import { useBranding } from '@/context/branding-provider'
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
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  viewLabel,
  allowedViews,
  stateLabel,
  money,
  number,
  time,
  accountSummary,
  filterAccounts,
  type ViewKey,
  type Vendor,
  type Resource,
} from './portal-model'

type Child = Vendor & { status: string; external_code: string }
type Statement = {
  id: string
  vendor_name: string
  period_start: string
  period_end: string
  status: string
  amount_usdt: number
  contract_version: number
  direction?: 'upstream' | 'downstream'
  counterparty_name?: string
  usage?: {
    requests?: number
    input_tokens?: number
    output_tokens?: number
    cost_usd?: number
    amount_usdt?: number
  }
}
type Billing = {
  upstream: Statement[]
  downstream: Statement[]
  profile: {
    contact_name?: string
    settlement_email?: string
    binance_id?: string
    default_price_cny_per_usd?: number
    group_prices?: Record<string, string>
    fx_cny_per_usdt?: number
    default_multiplier?: number
    contract_version?: number
  }
}
type Audit = {
  id: string
  action: string
  resource_type: string
  created_at: string
}
type UsageTrendRow = {
  date: string
  requests?: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
}
const selectClass = 'h-9 rounded-lg border bg-background px-3 text-sm'
const boxClass = 'rounded-xl border bg-card shadow-sm'
const EMPTY_ACCOUNT = {
  name: '',
  platform: 'anthropic',
  auth_method: 'oauth',
  proxy_id: '',
  runtime_type: 'docker',
  region: 'auto',
  locale: 'en_US.UTF-8',
}
const EMPTY_CHILD = {
  name: '',
  email: '',
  external_code: '',
  username: '',
  password: '',
  contact_name: '',
  settlement_email: '',
  binance_id: '',
  default_price_cny_per_usd: 1.6,
  fx_cny_per_usdt: 6.7,
  default_multiplier: 1,
}
const icons = {
  accounts: LayoutGrid,
  proxies: Globe2,
  vendors: Users,
  usage: BarChart3,
  billing: FileText,
  settlements: FileText,
  payables: FileText,
  audit: FileText,
}

function Quota({
  value,
  reset,
  label,
}: {
  value?: number | null
  reset?: string | null
  label: string
}) {
  return (
    <div className='grid grid-cols-[40px_70px_1fr] items-center gap-2 text-xs'>
      <span>{label}</span>
      <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
        <div
          className='h-full bg-teal-500'
          style={{
            width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%`,
          }}
        />
      </div>
      <span title={time(reset)}>
        {value == null ? '—' : `${(value * 100).toFixed(0)}%`} ·{' '}
        {reset ? time(reset) : translate('vendor:resetUnknown')}
      </span>
    </div>
  )
}
function State({
  loading,
  error,
  empty,
  retry,
}: {
  loading: boolean
  error: Error | null
  empty: boolean
  retry: () => void
}) {
  if (error)
    return (
      <div role='alert' className='p-8 text-center text-sm text-destructive'>
        {error.message}
        <Button className='ms-3' variant='outline' onClick={retry}>
          {translate('vendor:retry')}
        </Button>
      </div>
    )
  if (loading || empty)
    return (
      <div className='p-10 text-center text-sm text-muted-foreground'>
        {loading ? translate('vendor:loading') : translate('vendor:noRecords')}
      </div>
    )
  return null
}
function Table({
  columns,
  children,
}: {
  columns: string[]
  children: React.ReactNode
}) {
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-sm whitespace-nowrap'>
        <thead className='border-b bg-muted/30 text-xs text-muted-foreground'>
          <tr>
            {columns.map((c) => (
              <th key={c} className='px-4 py-3 text-start font-medium'>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y [&_td]:px-4 [&_td]:py-4'>{children}</tbody>
      </table>
    </div>
  )
}
function Field({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <label className='grid gap-2 text-sm font-medium'>
      {title}
      {children}
    </label>
  )
}

export function VendorPortalPage() {
  const { t } = useTranslation('vendor')
  const nav = useNavigate()
  const params = useParams({ strict: false }) as { page?: string }
  const view = (params.page || 'accounts') as ViewKey
  const qc = useQueryClient()
  const branding = useBranding()
  const [mobile, setMobile] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [refreshSeconds, setRefreshSeconds] = useState(60)
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [filterPlatform, setFilterPlatform] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [page, setPage] = useState(0)
  const [dialog, setDialog] = useState<'account' | 'proxy' | 'child' | null>(
    null
  )
  const [account, setAccount] = useState(EMPTY_ACCOUNT)
  const [child, setChild] = useState(EMPTY_CHILD)
  const [proxy, setProxy] = useState({ name: '', endpoint: '' })
  const [busy, setBusy] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingError, setBillingError] = useState('')
  const [billingChild, setBillingChild] = useState('')
  const [billingStart, setBillingStart] = useState(() =>
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  )
  const [billingEnd, setBillingEnd] = useState(() =>
    new Date().toISOString().slice(0, 10)
  )
  const [actionError, setActionError] = useState('')
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [selected, setSelected] = useState<Resource | null>(null)
  const me = useQuery({
    queryKey: ['vendor', 'me'],
    queryFn: () => api<{ vendor: Vendor }>('/api/vendor/me'),
    retry: false,
    refetchInterval: 30000,
  })
  const vendor = me.data?.vendor
  const allowed = vendor ? allowedViews(vendor) : []
  const permitted = allowed.includes(view)
  const canBrowseSuppliers = allowed.includes('vendors')
  const scope = canBrowseSuppliers ? supplierFilter : ''
  const accountView = view === 'accounts'
  const proxyView = view === 'proxies'
  const resourcePath = view === 'usage' ? 'accounts' : view
  const resources = useQuery({
    queryKey: ['vendor', resourcePath, scope],
    queryFn: () =>
      api<Resource[]>(
        '/api/vendor/' +
          resourcePath +
          (scope ? '?vendor_id=' + encodeURIComponent(scope) : '')
      ),
    enabled:
      !!vendor && permitted && (accountView || proxyView || view === 'usage'),
    refetchInterval: refreshSeconds ? refreshSeconds * 1000 : false,
  })
  const proxies = useQuery({
    queryKey: ['vendor', 'proxies'],
    queryFn: () => api<Resource[]>('/api/vendor/proxies'),
    enabled: !!vendor && dialog === 'account',
  })
  const children = useQuery({
    queryKey: ['vendor', 'vendors'],
    queryFn: () => api<Child[]>('/api/vendor/vendors'),
    enabled: !!vendor && canBrowseSuppliers,
  })
  const billing = useQuery({
    queryKey: ['vendor', 'billing'],
    queryFn: () => api<Billing>('/api/vendor/billing'),
    enabled: !!vendor && permitted && view === 'billing',
  })
  const usage = useQuery({
    queryKey: ['vendor', 'usage', scope, billingStart, billingEnd],
    queryFn: () =>
      api<{
        period: { start: string; end: string }
        summary: Record<string, unknown>
        trend: UsageTrendRow[]
        accounts: unknown[]
      }>(
        '/api/vendor/usage?start_date=' +
          billingStart +
          '&end_date=' +
          billingEnd +
          (scope ? '&vendor_id=' + encodeURIComponent(scope) : '')
      ),
    enabled: !!vendor && permitted && view === 'usage',
  })
  const audit = useQuery({
    queryKey: ['vendor', 'audit'],
    queryFn: () => api<Audit[]>('/api/vendor/audit-logs'),
    enabled: !!vendor && view === 'audit',
  })
  const all = resources.data || []
  const rows = accountView
    ? filterAccounts(all, search, filterPlatform, filterStatus)
    : all.filter(
        (r) => !search || r.name.toLowerCase().includes(search.toLowerCase())
      )
  const summary = accountSummary(all)
  const canManage = !!vendor?.capabilities.includes('vendor.resource.manage')
  const canCreateAccount =
    canManage && !scope && !!vendor?.capabilities.includes('vendor.vm.create')
  const refresh = () => qc.invalidateQueries({ queryKey: ['vendor'] })
  const open = (kind: 'account' | 'proxy' | 'child') => {
    setActionError('')
    setIdem(crypto.randomUUID())
    setDialog(kind)
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setActionError('')
    try {
      const path =
        dialog === 'child'
          ? 'vendors'
          : dialog === 'proxy'
            ? 'proxies'
            : 'accounts'
      const body =
        dialog === 'child'
          ? child
          : dialog === 'proxy'
            ? { name: proxy.name, config: { endpoint: proxy.endpoint } }
            : { ...account, proxy_id: account.proxy_id || null }
      await api('/api/vendor/' + path, {
        method: 'POST',
        body: JSON.stringify({ ...body, idempotency_key: idem }),
      })
      setDialog(null)
      setAccount(EMPTY_ACCOUNT)
      setChild(EMPTY_CHILD)
      setProxy({ name: '', endpoint: '' })
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (r: Resource) => {
    setBusy(true)
    setActionError('')
    try {
      await api(
        `/api/vendor/${r.resource_type === 'proxy' ? 'proxies' : 'accounts'}/${r.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: r.status === 'paused' ? 'active' : 'paused',
          }),
        }
      )
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }
  const createSettlement = async () => {
    if (!billingChild || billingBusy) return
    setBillingBusy(true)
    setBillingError('')
    try {
      await api('/api/vendor/settlements', {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: billingChild,
          start_date: billingStart,
          end_date: billingEnd,
        }),
      })
      await billing.refetch()
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : t('settlementFailed'))
    } finally {
      setBillingBusy(false)
    }
  }
  const switchView = (key: ViewKey) => {
    setMobile(false)
    setSearch('')
    setFilterPlatform('all')
    setFilterStatus('all')
    setPage(0)
    setActionError('')
    void nav({ to: '/vendor/$page', params: { page: key } })
  }
  if (me.isPending || me.error || !vendor)
    return (
      <div className='p-8'>
        <h1 className='text-xl font-semibold'>{t('portal')}</h1>
        <State
          loading={me.isPending}
          error={me.error}
          empty={!vendor}
          retry={() => me.refetch()}
        />
        <Button
          variant='outline'
          onClick={() => nav({ to: '/login', search: { redirect: '/vendor' } })}
        >
          {t('backToLogin')}
        </Button>
      </div>
    )
  const groups: { label: string; keys: ViewKey[] }[] = [
    { label: t('resources'), keys: ['accounts', 'proxies', 'vendors'] },
    { label: t('statistics'), keys: ['usage', 'billing', 'audit'] },
  ]
  const navigation = (
    <nav
      aria-label={t('navLabel')}
      className='flex-1 space-y-6 overflow-y-auto p-3'
    >
      {groups
        .filter((g) => g.keys.some((k) => allowed.includes(k)))
        .map((g) => (
          <div key={g.label}>
            <p className='px-3 pb-2 text-xs text-muted-foreground'>{g.label}</p>
            {g.keys
              .filter((k) => allowed.includes(k))
              .map((k) => {
                const Icon = icons[k]
                return (
                  <button
                    key={k}
                    aria-current={view === k ? 'page' : undefined}
                    onClick={() => switchView(k)}
                    className={`my-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${view === k ? 'bg-teal-500/10 font-medium text-teal-600' : 'text-muted-foreground hover:bg-muted'}`}
                  >
                    <Icon className='size-4' />
                    {viewLabel(k)}
                  </button>
                )
              })}
          </div>
        ))}
    </nav>
  )
  const pageRows = rows.slice(page * 20, (page + 1) * 20)
  const currentQuery =
    view === 'vendors'
      ? children
      : view === 'audit'
        ? audit
        : view === 'billing'
          ? billing
          : view === 'usage'
            ? usage
            : resources
  return (
    <div className='min-h-svh bg-muted/20'>
      <aside
        className={`fixed inset-y-0 start-0 z-20 hidden flex-col border-e bg-background lg:flex ${collapsed ? 'w-16' : 'w-56'}`}
      >
        <div className='flex h-16 items-center gap-3 border-b px-4'>
          <img
            src={branding.logo_url || './favicon.svg'}
            alt=''
            className='size-8 rounded-lg'
          />
          {!collapsed && <span className='font-semibold'>{branding.name}</span>}
        </div>
        {!collapsed && navigation}
        <Button
          variant='ghost'
          aria-label={collapsed ? t('expandNav') : t('collapseNav')}
          className='m-2 mt-auto'
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft className={collapsed ? 'rotate-180' : ''} />
          {!collapsed && t('collapse')}
        </Button>
      </aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side='left'>
          <SheetTitle className='p-4'>{t('portal')}</SheetTitle>
          {navigation}
        </SheetContent>
      </Sheet>
      <main className={collapsed ? 'lg:ps-16' : 'lg:ps-56'}>
        <header className='flex h-16 items-center justify-between border-b bg-background px-5'>
          <div className='flex items-center gap-3'>
            <Button
              className='lg:hidden'
              variant='ghost'
              size='icon'
              aria-label={t('openNav')}
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <span className='text-sm font-medium'>
              {viewLabel(view) || t('noPermissionPage')}
            </span>
          </div>
          <div className='flex items-center gap-3'>
            <ThemeSwitch />
            <div className='text-end text-xs'>
              <p className='font-medium'>{vendor.name}</p>
              <span className='text-muted-foreground'>
                {vendor.tier === 1 ? t('tierOne') : t('tierTwo')}
              </span>
            </div>
            <Button
              variant='ghost'
              size='icon'
              aria-label={t('logout')}
              onClick={() => {
                clearSession()
                qc.clear()
                void nav({ to: '/login', search: { redirect: '/vendor' } })
              }}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        <div className='space-y-5 p-4 lg:p-6'>
          {!permitted ? (
            <div role='alert' className={boxClass + ' p-8'}>
              {t('noPagePermission')}
              <Button variant='link' onClick={() => switchView('accounts')}>
                {t('backToAccounts')}
              </Button>
            </div>
          ) : (
            <>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <h1 className='text-xl font-semibold'>{viewLabel(view)}</h1>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    {scope ? t('scopeReadOnly') : t('manageResources')}
                  </p>
                </div>
                <div className='flex gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={refresh}
                    loading={currentQuery.isFetching}
                  >
                    <RefreshCw />
                    {t('refresh')}
                  </Button>
                  {accountView && canCreateAccount && (
                    <Button size='sm' onClick={() => open('account')}>
                      <Plus />
                      {t('addAccount')}
                    </Button>
                  )}
                  {proxyView && canManage && !scope && (
                    <Button size='sm' onClick={() => open('proxy')}>
                      <Plus />
                      {t('addProxy')}
                    </Button>
                  )}
                  {view === 'vendors' && (
                    <Button size='sm' onClick={() => open('child')}>
                      <Plus />
                      {t('addVendor')}
                    </Button>
                  )}
                </div>
              </div>
              {actionError && (
                <p role='alert' className='text-sm text-destructive'>
                  {actionError}
                </p>
              )}
              {(accountView || view === 'usage') && (
                <section className={boxClass + ' p-4'}>
                  <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
                    <h2 className='text-sm font-semibold'>
                      {scope
                        ? t('accountOverviewScoped')
                        : t('accountOverviewMine')}
                    </h2>
                    <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                      {t('autoRefresh')}
                      <select
                        className={selectClass}
                        value={refreshSeconds}
                        onChange={(e) =>
                          setRefreshSeconds(Number(e.target.value))
                        }
                      >
                        <option value={0}>{t('off')}</option>
                        <option value={60}>{t('oneMinute')}</option>
                        <option value={300}>{t('fiveMinutes')}</option>
                      </select>
                    </label>
                  </div>
                  <div className='grid grid-cols-2 gap-5 md:grid-cols-4 xl:grid-cols-8'>
                    {[
                      [t('totalAccounts'), summary.total],
                      [t('availableAccounts'), summary.available],
                      [t('waitingAuth'), summary.unauthorized],
                      [t('pausedAccounts'), summary.paused],
                      ['RPM', number(summary.rpm)],
                      [t('tpm'), number(summary.tpm)],
                      [t('liveConcurrency'), number(summary.inflight)],
                      [t('nearLimit'), summary.nearLimit],
                      [
                        t('totalCost'),
                        summary.reported ? money(summary.cost) : '—',
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <div className='text-xs text-muted-foreground'>
                          {label}
                        </div>
                        <div className='mt-2 text-xl font-semibold tabular-nums'>
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className='mt-4 text-xs text-muted-foreground'>
                    {t('summaryPrefix')}
                    {summary.reported} / {summary.total} {t('summarySuffix')}
                  </p>
                </section>
              )}
              {(accountView || proxyView) && (
                <section className={boxClass}>
                  <div className='flex flex-wrap gap-2 border-b p-3'>
                    <select
                      aria-label={t('vendorFilter')}
                      className={selectClass}
                      value={scope}
                      onChange={(e) => {
                        setSupplierFilter(e.target.value)
                        setPage(0)
                      }}
                    >
                      <option value=''>
                        {t('myResources')} {vendor.name}
                      </option>
                      {canBrowseSuppliers && (
                        <option value='all'>{t('allVisibleVendors')}</option>
                      )}
                      {canBrowseSuppliers &&
                        children.data
                          ?.filter((c) => c.id !== vendor.id)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                    </select>
                    {canBrowseSuppliers && children.error && (
                      <span role='alert' className='text-sm text-destructive'>
                        {t('vendorsLoadFailed')}
                      </span>
                    )}

                    <div className='relative'>
                      <Search className='absolute start-3 top-2.5 size-4 text-muted-foreground' />
                      <Input
                        aria-label={t('searchResources')}
                        className='ps-9'
                        placeholder={t('searchPlaceholder')}
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value)
                          setPage(0)
                        }}
                      />
                    </div>
                    {accountView && (
                      <>
                        <select
                          aria-label={t('platformFilter')}
                          className={selectClass}
                          value={filterPlatform}
                          onChange={(e) => {
                            setFilterPlatform(e.target.value)
                            setPage(0)
                          }}
                        >
                          <option value='all'>{t('allPlatforms')}</option>
                          <option value='anthropic'>Claude</option>
                          <option value='openai'>OpenAI</option>
                        </select>
                        <select
                          aria-label={t('statusFilter')}
                          className={selectClass}
                          value={filterStatus}
                          onChange={(e) => {
                            setFilterStatus(e.target.value)
                            setPage(0)
                          }}
                        >
                          <option value='all'>{t('allStatuses')}</option>
                          {[
                            'available',
                            'unauthorized',
                            'unavailable',
                            'provisioning',
                            'paused',
                          ].map((s) => (
                            <option key={s} value={s}>
                              {stateLabel(s)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                  <State
                    loading={resources.isPending}
                    error={resources.error}
                    empty={!rows.length}
                    retry={() => resources.refetch()}
                  />
                  {!resources.error &&
                    rows.length > 0 &&
                    (proxyView ? (
                      <Table
                        columns={[
                          t('name'),
                          t('status'),
                          t('proxyEndpoint'),
                          t('vendor'),
                          t('createdAt'),
                          t('actions'),
                        ]}
                      >
                        {pageRows.map((r) => (
                          <tr key={r.id}>
                            <td>{r.name}</td>
                            <td>{stateLabel(r.status)}</td>
                            <td>{String(r.config.endpoint || '—')}</td>
                            <td>
                              {r.vendor_id === vendor.id
                                ? vendor.name
                                : children.data?.find(
                                    (c) => c.id === r.vendor_id
                                  )?.name || r.vendor_id}
                            </td>
                            <td>{time(r.created_at)}</td>
                            <td>
                              {canManage && r.vendor_id === vendor.id && (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  disabled={busy}
                                  onClick={() => toggle(r)}
                                >
                                  {r.status === 'paused'
                                    ? t('resume')
                                    : t('pause')}
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </Table>
                    ) : (
                      <Table
                        columns={[
                          t('nameAccount'),
                          t('vendor'),
                          t('status'),
                          t('platformAuth'),
                          t('quotaWindow'),
                          t('concurrency'),
                          t('todayCost'),
                          t('totalCost'),
                          t('cacheHitRate'),
                          t('createdAt'),
                          t('actions'),
                        ]}
                      >
                        {pageRows.map((r) => {
                          const telemetry = r.telemetry
                          return (
                            <tr key={r.id} className='hover:bg-muted/20'>
                              <td>
                                <p className='font-medium'>{r.name}</p>
                                <p className='mt-1 text-xs text-muted-foreground'>
                                  {telemetry?.email || r.id}
                                </p>
                              </td>
                              <td>
                                {r.vendor_id === vendor.id
                                  ? vendor.name
                                  : children.data?.find(
                                      (c) => c.id === r.vendor_id
                                    )?.name || r.vendor_id}
                              </td>
                              <td>
                                <span
                                  className={`rounded-full px-2 py-1 text-xs ${telemetry?.state === 'available' ? 'bg-teal-500/10 text-teal-600' : 'bg-muted text-muted-foreground'}`}
                                >
                                  {stateLabel(
                                    telemetry?.state || 'provisioning'
                                  )}
                                </span>
                              </td>
                              <td>
                                {r.config.platform === 'anthropic'
                                  ? 'Claude'
                                  : String(r.config.platform || '—')}
                                <p className='mt-1 text-xs text-muted-foreground'>
                                  {String(r.config.auth_method || '—')}
                                </p>
                              </td>
                              <td className='space-y-2'>
                                <Quota
                                  label={t('sevenDays')}
                                  value={telemetry?.utilization_7d}
                                  reset={telemetry?.reset_7d}
                                />
                                <Quota
                                  label={t('fiveHours')}
                                  value={telemetry?.utilization_5h}
                                  reset={telemetry?.reset_5h}
                                />
                              </td>
                              <td>
                                {number(telemetry?.inflight)} /{' '}
                                {telemetry?.max_concurrency === 0
                                  ? t('unlimited')
                                  : number(telemetry?.max_concurrency)}
                              </td>
                              <td>{money(telemetry?.today_cost)}</td>
                              <td>{money(telemetry?.total_cost)}</td>
                              <td>
                                {telemetry?.cache_hit_rate == null
                                  ? '—'
                                  : `${(telemetry.cache_hit_rate * 100).toFixed(1)}%`}
                              </td>
                              <td className='text-xs'>{time(r.created_at)}</td>
                              <td>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={() => setSelected(r)}
                                >
                                  {t('details')}
                                </Button>
                                {canManage && r.vendor_id === vendor.id && (
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    disabled={busy}
                                    onClick={() => toggle(r)}
                                  >
                                    {r.status === 'paused'
                                      ? t('resume')
                                      : t('pause')}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </Table>
                    ))}
                  <div className='flex items-center justify-between border-t p-3 text-xs text-muted-foreground'>
                    <span>
                      {t('totalPrefix')} {rows.length} {t('totalSuffix')}
                    </span>
                    <div className='flex items-center gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={page === 0}
                        onClick={() => setPage(page - 1)}
                      >
                        {t('previous')}
                      </Button>
                      {page + 1}
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={(page + 1) * 20 >= rows.length}
                        onClick={() => setPage(page + 1)}
                      >
                        {t('next')}
                      </Button>
                    </div>
                  </div>
                </section>
              )}
              {view === 'usage' && (
                <section className={boxClass + ' space-y-4 p-4'}>
                  <div className='flex flex-wrap items-end gap-3'>
                    <Field title={t('startDate')}>
                      <Input
                        type='date'
                        value={billingStart}
                        onChange={(e) => setBillingStart(e.target.value)}
                      />
                    </Field>
                    <Field title={t('endDate')}>
                      <Input
                        type='date'
                        value={billingEnd}
                        onChange={(e) => setBillingEnd(e.target.value)}
                      />
                    </Field>
                    <select
                      aria-label={t('vendorFilter')}
                      className={selectClass}
                      value={scope}
                      onChange={(e) => {
                        setSupplierFilter(e.target.value)
                        setPage(0)
                      }}
                    >
                      <option value=''>
                        {t('myResources')} {vendor.name}
                      </option>
                      {canBrowseSuppliers && (
                        <option value='all'>{t('allVisibleVendors')}</option>
                      )}
                      {canBrowseSuppliers &&
                        children.data
                          ?.filter((c) => c.id !== vendor.id)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                    </select>
                    <Button
                      variant='outline'
                      onClick={() => usage.refetch()}
                      loading={usage.isFetching}
                    >
                      {t('query')}
                    </Button>
                  </div>
                  <div className='grid gap-4 md:grid-cols-4'>
                    {[
                      [t('totalRequests'), usage.data?.summary?.requests],
                      [t('inputTokens'), usage.data?.summary?.input_tokens],
                      [t('outputTokens'), usage.data?.summary?.output_tokens],
                      [
                        t('spendAmount'),
                        usage.data?.summary?.cost_usd == null
                          ? '—'
                          : money(Number(usage.data.summary.cost_usd)),
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={String(label)}
                        className='rounded-lg border p-4'
                      >
                        <p className='text-xs text-muted-foreground'>
                          {String(label)}
                        </p>
                        <p className='mt-2 text-xl font-semibold'>
                          {value == null ? '—' : number(Number(value))}
                        </p>
                      </div>
                    ))}
                  </div>
                  <State
                    loading={usage.isPending}
                    error={usage.error}
                    empty={
                      !usage.data?.trend?.length &&
                      !usage.data?.accounts?.length
                    }
                    retry={() => usage.refetch()}
                  />
                  {!!usage.data?.trend?.length && (
                    <Table
                      columns={[
                        t('date'),
                        t('requests'),
                        t('inputTokens'),
                        t('outputTokens'),
                        t('spend'),
                      ]}
                    >
                      {usage.data.trend.map((row) => (
                        <tr key={row.date}>
                          <td>{row.date}</td>
                          <td>{number(row.requests)}</td>
                          <td>{number(row.input_tokens)}</td>
                          <td>{number(row.output_tokens)}</td>
                          <td>{money(row.cost_usd)}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </section>
              )}
              {view === 'billing' && (
                <section className={boxClass + ' space-y-5 p-4'}>
                  <div className='grid gap-4 md:grid-cols-4'>
                    <div>
                      <p className='text-xs text-muted-foreground'>
                        {t('settlementContact')}
                      </p>
                      <p className='mt-1'>
                        {billing.data?.profile.contact_name || '—'}
                      </p>
                    </div>
                    <div>
                      <p className='text-xs text-muted-foreground'>
                        {t('settlementEmail')}
                      </p>
                      <p className='mt-1'>
                        {billing.data?.profile.settlement_email || '—'}
                      </p>
                    </div>
                    <div>
                      <p className='text-xs text-muted-foreground'>
                        {t('defaultPurchasePrice')}
                      </p>
                      <p className='mt-1'>
                        {billing.data?.profile.default_price_cny_per_usd ?? '—'}{' '}
                        {t('cnyUsd')}
                      </p>
                    </div>
                    <div>
                      <p className='text-xs text-muted-foreground'>
                        {t('settlementRate')}
                      </p>
                      <p className='mt-1'>
                        {billing.data?.profile.fx_cny_per_usdt ?? '—'}{' '}
                        {t('cnyUsdt')}
                      </p>
                    </div>
                  </div>
                  {canBrowseSuppliers && (
                    <div className='flex flex-wrap items-end gap-3 border-y py-4'>
                      <Field title={t('downstreamVendor')}>
                        <select
                          className={selectClass}
                          value={billingChild}
                          onChange={(e) => setBillingChild(e.target.value)}
                        >
                          <option value=''>
                            {t('selectDownstreamVendor')}
                          </option>
                          {children.data
                            ?.filter((c) => c.tier === 2)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field title={t('startDate')}>
                        <Input
                          type='date'
                          value={billingStart}
                          onChange={(e) => setBillingStart(e.target.value)}
                        />
                      </Field>
                      <Field title={t('endDate')}>
                        <Input
                          type='date'
                          value={billingEnd}
                          onChange={(e) => setBillingEnd(e.target.value)}
                        />
                      </Field>
                      <Button
                        onClick={createSettlement}
                        disabled={!billingChild || billingBusy}
                        loading={billingBusy}
                      >
                        {t('addSettlement')}
                      </Button>
                    </div>
                  )}
                  {billingError && (
                    <p role='alert' className='text-sm text-destructive'>
                      {billingError}
                    </p>
                  )}
                  <div>
                    <h2 className='mb-2 text-sm font-semibold'>
                      {t('upstreamBills')}
                    </h2>
                    <Table
                      columns={[
                        t('bill'),
                        t('period'),
                        t('status'),
                        t('amountUsdt'),
                        t('contract'),
                      ]}
                    >
                      {billing.data?.upstream.map((s) => (
                        <tr key={s.id}>
                          <td>{s.id}</td>
                          <td>
                            {time(s.period_start)} — {time(s.period_end)}
                          </td>
                          <td>{s.status}</td>
                          <td>{s.amount_usdt}</td>
                          <td>v{s.contract_version}</td>
                        </tr>
                      ))}
                    </Table>
                  </div>
                  {canBrowseSuppliers && (
                    <div>
                      <h2 className='mb-2 text-sm font-semibold'>
                        {t('downstreamBills')}
                      </h2>
                      <Table
                        columns={[
                          t('downstreamVendor'),
                          t('period'),
                          t('status'),
                          t('amountUsdt'),
                          t('contract'),
                        ]}
                      >
                        {billing.data?.downstream.map((s) => (
                          <tr key={s.id}>
                            <td>{s.counterparty_name || '—'}</td>
                            <td>
                              {time(s.period_start)} — {time(s.period_end)}
                            </td>
                            <td>{s.status}</td>
                            <td>{s.amount_usdt}</td>
                            <td>v{s.contract_version}</td>
                          </tr>
                        ))}
                      </Table>
                    </div>
                  )}
                </section>
              )}
              {view === 'vendors' && (
                <section className={boxClass}>
                  <div className='border-b p-4 text-sm'>
                    {t('directChildVendors')}
                    {children.data?.filter((c) => c.tier === 2).length ??
                      '—'} /{' '}
                    {vendor.child_limit === 0
                      ? t('unlimited')
                      : vendor.child_limit}
                  </div>
                  <State
                    loading={children.isPending}
                    error={children.error}
                    empty={!children.data?.some((c) => c.tier === 2)}
                    retry={() => children.refetch()}
                  />
                  <Table
                    columns={[
                      t('name'),
                      t('email'),
                      t('status'),
                      t('accountQuota'),
                      t('proxyQuota'),
                    ]}
                  >
                    {children.data
                      ?.filter((c) => c.tier === 2)
                      .map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td>{c.email}</td>
                          <td>{stateLabel(c.status)}</td>
                          <td>{c.account_limit || t('unlimited')}</td>
                          <td>{c.proxy_limit || t('unlimited')}</td>
                        </tr>
                      ))}
                  </Table>
                </section>
              )}
              {view === 'audit' && (
                <section className={boxClass}>
                  <State
                    loading={audit.isPending}
                    error={audit.error}
                    empty={!audit.data?.length}
                    retry={() => audit.refetch()}
                  />
                  <Table columns={[t('actions'), t('resources'), t('time')]}>
                    {audit.data?.map((a) => (
                      <tr key={a.id}>
                        <td>{a.action}</td>
                        <td>{a.resource_type || t('vendor')}</td>
                        <td>{time(a.created_at)}</td>
                      </tr>
                    ))}
                  </Table>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>
              {dialog === 'account'
                ? t('addAccount')
                : dialog === 'proxy'
                  ? t('addProxy')
                  : t('addChildVendor')}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'account'
                ? t('accountDialogDescription')
                : dialog === 'child'
                  ? t('childDialogDescription')
                  : t('proxyDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <form className='space-y-4' onSubmit={submit}>
            {dialog === 'account' && (
              <>
                <Field title={t('accountName')}>
                  <Input
                    required
                    value={account.name}
                    onChange={(e) =>
                      setAccount({ ...account, name: e.target.value })
                    }
                  />
                </Field>
                <div className='grid gap-4 sm:grid-cols-2'>
                  <Field title={t('platform')}>
                    <select
                      className={selectClass}
                      value={account.platform}
                      onChange={(e) =>
                        setAccount({
                          ...account,
                          platform: e.target.value,
                          auth_method: 'oauth',
                        })
                      }
                    >
                      <option value='anthropic'>Claude</option>
                      <option value='openai'>OpenAI</option>
                    </select>
                  </Field>
                  <Field title={t('authMethod')}>
                    <select
                      className={selectClass}
                      value={account.auth_method}
                      onChange={(e) =>
                        setAccount({ ...account, auth_method: e.target.value })
                      }
                    >
                      <option value='oauth'>OAuth</option>
                      {account.platform === 'anthropic' && (
                        <option value='setup-token'>Setup Token</option>
                      )}
                      <option value='manual'>{t('manualCredentials')}</option>
                    </select>
                  </Field>
                </div>
                <Field title={t('proxy')}>
                  <select
                    className={selectClass}
                    value={account.proxy_id}
                    onChange={(e) =>
                      setAccount({ ...account, proxy_id: e.target.value })
                    }
                  >
                    <option value=''>{t('noProxy')}</option>
                    {proxies.data
                      ?.filter((p) => p.status === 'active')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {proxies.error && (
                  <p role='alert' className='text-sm text-destructive'>
                    {proxies.error.message}
                  </p>
                )}
                <details className='rounded-lg border p-3'>
                  <summary className='cursor-pointer text-sm'>
                    {t('runtime')}
                  </summary>
                  <div className='mt-4 grid gap-4 sm:grid-cols-2'>
                    <Field title={t('environment')}>
                      <select
                        className={selectClass}
                        value={account.runtime_type}
                        onChange={(e) =>
                          setAccount({
                            ...account,
                            runtime_type: e.target.value,
                          })
                        }
                      >
                        <option value='docker'>Docker</option>
                        <option value='kvm'>KVM</option>
                      </select>
                    </Field>
                    <Field title={t('language')}>
                      <select
                        className={selectClass}
                        value={account.locale}
                        onChange={(e) =>
                          setAccount({ ...account, locale: e.target.value })
                        }
                      >
                        {[
                          'en_US.UTF-8',
                          'zh_CN.UTF-8',
                          'zh_TW.UTF-8',
                          'ja_JP.UTF-8',
                          'C.UTF-8',
                        ].map((l) => (
                          <option key={l} value={l}>
                            {l === 'C.UTF-8' ? t('genericLocale') : l}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                </details>
              </>
            )}
            {dialog === 'child' && (
              <div className='space-y-4'>
                <div className='grid gap-4 sm:grid-cols-2'>
                  <Field title={t('vendorName')}>
                    <Input
                      required
                      value={child.name}
                      onChange={(e) =>
                        setChild({ ...child, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('email')}>
                    <Input
                      type='email'
                      required
                      value={child.email}
                      onChange={(e) =>
                        setChild({ ...child, email: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('username')}>
                    <Input
                      required
                      value={child.username}
                      onChange={(e) =>
                        setChild({ ...child, username: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('password')}>
                    <Input
                      type='password'
                      required
                      value={child.password}
                      onChange={(e) =>
                        setChild({ ...child, password: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('vendorCode')}>
                    <Input
                      required
                      value={child.external_code}
                      onChange={(e) =>
                        setChild({ ...child, external_code: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('contact')}>
                    <Input
                      value={child.contact_name}
                      onChange={(e) =>
                        setChild({ ...child, contact_name: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('settlementEmail')}>
                    <Input
                      type='email'
                      value={child.settlement_email}
                      onChange={(e) =>
                        setChild({ ...child, settlement_email: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('binanceId')}>
                    <Input
                      value={child.binance_id}
                      onChange={(e) =>
                        setChild({ ...child, binance_id: e.target.value })
                      }
                    />
                  </Field>
                  <Field title={t('purchasePrice')}>
                    <Input
                      type='number'
                      min='0.0001'
                      step='0.0001'
                      value={child.default_price_cny_per_usd}
                      onChange={(e) =>
                        setChild({
                          ...child,
                          default_price_cny_per_usd: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field title={t('settlementRateFull')}>
                    <Input
                      type='number'
                      min='0.0001'
                      step='0.0001'
                      value={child.fx_cny_per_usdt}
                      onChange={(e) =>
                        setChild({
                          ...child,
                          fx_cny_per_usdt: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field title={t('settlementMultiplier')}>
                    <Input
                      type='number'
                      min='0.0001'
                      step='0.0001'
                      value={child.default_multiplier}
                      onChange={(e) =>
                        setChild({
                          ...child,
                          default_multiplier: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
            {dialog === 'proxy' && (
              <>
                <Field title={t('proxyName')}>
                  <Input
                    required
                    value={proxy.name}
                    onChange={(e) =>
                      setProxy({ ...proxy, name: e.target.value })
                    }
                  />
                </Field>
                <Field title={t('proxyEndpoint')}>
                  <Input
                    required
                    type='url'
                    placeholder='http://user:pass@host:port'
                    value={proxy.endpoint}
                    onChange={(e) =>
                      setProxy({ ...proxy, endpoint: e.target.value })
                    }
                  />
                </Field>
              </>
            )}
            {dialog === 'child' &&
              Object.entries({
                name: t('vendorName'),
                email: t('email'),
                external_code: t('vendorCode'),
                username: t('loginUsername'),
                password: t('loginPassword'),
              }).map(([key, label]) => (
                <Field key={key} title={label}>
                  <Input
                    required
                    type={
                      key === 'password'
                        ? 'password'
                        : key === 'email'
                          ? 'email'
                          : 'text'
                    }
                    minLength={key === 'password' ? 8 : undefined}
                    autoComplete={key === 'password' ? 'new-password' : 'off'}
                    value={child[key as keyof typeof child]}
                    onChange={(e) =>
                      setChild({ ...child, [key]: e.target.value })
                    }
                  />
                </Field>
              ))}
            {actionError && (
              <p role='alert' className='text-sm text-destructive'>
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t('cancel')}
              </Button>
              <Button type='submit' loading={busy}>
                {t('create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>{t('accountDetails')}</DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className='grid grid-cols-[110px_1fr] gap-3 text-sm break-all'>
              {[
                [t('accountId'), selected.id],
                [t('linkedVm'), selected.telemetry?.vm_id || t('provisioning')],
                [
                  t('status'),
                  stateLabel(selected.telemetry?.state || 'provisioning'),
                ],
                [t('totalCost'), money(selected.telemetry?.total_cost)],
                [t('requests'), number(selected.telemetry?.requests)],
                [t('token'), number(selected.telemetry?.total_tokens)],
              ].map(([k, v]) => (
                <div key={k} className='contents'>
                  <dt className='text-muted-foreground'>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
export const vendorRouteBeforeLoad = async () => {
  if (!hasSession())
    throw redirect({ to: '/login', search: { redirect: '/vendor' } })
}

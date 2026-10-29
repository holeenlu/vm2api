import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { redirect, useNavigate, useParams } from '@tanstack/react-router'
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
  VIEW_LABELS,
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
  usage?: { requests?: number; input_tokens?: number; output_tokens?: number; cost_usd?: number; amount_usdt?: number }
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
        {reset ? time(reset) : '重置时间未知'}
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
          重试
        </Button>
      </div>
    )
  if (loading || empty)
    return (
      <div className='p-10 text-center text-sm text-muted-foreground'>
        {loading ? '正在加载…' : '当前范围暂无记录。'}
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
  const [billingStart, setBillingStart] = useState(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
  const [billingEnd, setBillingEnd] = useState(() => new Date().toISOString().slice(0, 10))
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
    queryFn: () => api<{ period: { start: string; end: string }; summary: Record<string, unknown>; trend: unknown[]; accounts: unknown[] }>('/api/vendor/usage?start_date=' + billingStart + '&end_date=' + billingEnd + (scope ? '&vendor_id=' + encodeURIComponent(scope) : '')),
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
      setActionError(e instanceof Error ? e.message : '保存失败')
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
      setActionError(e instanceof Error ? e.message : '更新失败')
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
        body: JSON.stringify({ vendor_id: billingChild, start_date: billingStart, end_date: billingEnd }),
      })
      await billing.refetch()
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : '结算创建失败')
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
        <h1 className='text-xl font-semibold'>供应商平台</h1>
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
          返回登录
        </Button>
      </div>
    )
  const groups: { label: string; keys: ViewKey[] }[] = [
    { label: '资源', keys: ['accounts', 'proxies', 'vendors'] },
    { label: '统计', keys: ['usage', 'billing', 'audit'] },
  ]
  const navigation = (
    <nav
      aria-label='供应商导航'
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
                    {VIEW_LABELS[k]}
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
          aria-label={collapsed ? '展开导航' : '收起导航'}
          className='m-2 mt-auto'
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronLeft className={collapsed ? 'rotate-180' : ''} />
          {!collapsed && '收起'}
        </Button>
      </aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side='left'>
          <SheetTitle className='p-4'>供应商平台</SheetTitle>
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
              aria-label='打开导航'
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <span className='text-sm font-medium'>
              {VIEW_LABELS[view] || '无权限页面'}
            </span>
          </div>
          <div className='flex items-center gap-3'>
            <ThemeSwitch />
            <div className='text-end text-xs'>
              <p className='font-medium'>{vendor.name}</p>
              <span className='text-muted-foreground'>
                {vendor.tier === 1 ? '一级供应商' : '二级供应商'}
              </span>
            </div>
            <Button
              variant='ghost'
              size='icon'
              aria-label='退出登录'
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
              当前供应商没有访问该页面的权限。
              <Button variant='link' onClick={() => switchView('accounts')}>
                返回账号池
              </Button>
            </div>
          ) : (
            <>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <h1 className='text-xl font-semibold'>{VIEW_LABELS[view]}</h1>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    {scope
                      ? '可查询自己及直属供应商；下级资源只读。'
                      : '管理自己的资源和供给状态'}
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
                    刷新
                  </Button>
                  {accountView && canCreateAccount && (
                    <Button size='sm' onClick={() => open('account')}>
                      <Plus />
                      添加账号
                    </Button>
                  )}
                  {proxyView && canManage && !scope && (
                    <Button size='sm' onClick={() => open('proxy')}>
                      <Plus />
                      添加代理
                    </Button>
                  )}
                  {view === 'vendors' && (
                    <Button size='sm' onClick={() => open('child')}>
                      <Plus />
                      新增供应商
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
                        ? '账号概览（当前供应商范围）'
                        : '账号概览（我的账号）'}
                    </h2>
                    <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                      自动刷新
                      <select
                        className={selectClass}
                        value={refreshSeconds}
                        onChange={(e) =>
                          setRefreshSeconds(Number(e.target.value))
                        }
                      >
                        <option value={0}>关闭</option>
                        <option value={60}>1 分钟</option>
                        <option value={300}>5 分钟</option>
                      </select>
                    </label>
                  </div>
                  <div className='grid grid-cols-2 gap-5 md:grid-cols-4 xl:grid-cols-8'>
                    {[
                      ['总账号数', summary.total],
                      ['可用账号', summary.available],
                      ['等待授权', summary.unauthorized],
                      ['暂停账号', summary.paused],
                      ['RPM', number(summary.rpm)],
                      ['TPM', number(summary.tpm)],
                      ['实时并发', number(summary.inflight)],
                      ['接近限额', summary.nearLimit],
                      [
                        '累计消耗',
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
                    仅统计当前资源范围。{summary.reported} / {summary.total}{' '}
                    个账号有用量快照；未采集数据以 — 显示。
                  </p>
                </section>
              )}
              {(accountView || proxyView) && (
                <section className={boxClass}>
                  <div className='flex flex-wrap gap-2 border-b p-3'>
                    <select
                      aria-label='供应商筛选'
                      className={selectClass}
                      value={scope}
                      onChange={(e) => {
                        setSupplierFilter(e.target.value)
                        setPage(0)
                      }}
                    >
                      <option value=''>我的资源 · {vendor.name}</option>
                      {canBrowseSuppliers && (
                        <option value='all'>全部可见供应商</option>
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
                        供应商列表加载失败
                      </span>
                    )}

                    <div className='relative'>
                      <Search className='absolute start-3 top-2.5 size-4 text-muted-foreground' />
                      <Input
                        aria-label='搜索资源'
                        className='ps-9'
                        placeholder='搜索名称 / 账号 ID'
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
                          aria-label='平台筛选'
                          className={selectClass}
                          value={filterPlatform}
                          onChange={(e) => {
                            setFilterPlatform(e.target.value)
                            setPage(0)
                          }}
                        >
                          <option value='all'>全部平台</option>
                          <option value='anthropic'>Claude</option>
                          <option value='openai'>OpenAI</option>
                        </select>
                        <select
                          aria-label='状态筛选'
                          className={selectClass}
                          value={filterStatus}
                          onChange={(e) => {
                            setFilterStatus(e.target.value)
                            setPage(0)
                          }}
                        >
                          <option value='all'>全部状态</option>
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
                    loading={view === 'usage' ? usage.isPending : resources.isPending}
                    error={view === 'usage' ? usage.error : resources.error}
                    empty={!rows.length}
                    retry={() => (view === 'usage' ? usage.refetch() : resources.refetch())}
                  />
                  {!resources.error &&
                    rows.length > 0 &&
                    (proxyView ? (
                      <Table
                        columns={[
                          '名称',
                          '状态',
                          '代理地址',
                          '供应商',
                          '创建时间',
                          '操作',
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
                                  {r.status === 'paused' ? '恢复' : '暂停'}
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </Table>
                    ) : (
                      <Table
                        columns={[
                          '名称 / 账号',
                          '供应商',
                          '状态',
                          '平台 / 授权',
                          '配额窗口',
                          '并发',
                          '今日消耗',
                          '累计消耗',
                          '缓存命中率',
                          '创建时间',
                          '操作',
                        ]}
                      >
                        {pageRows.map((r) => {
                          const t = r.telemetry
                          return (
                            <tr key={r.id} className='hover:bg-muted/20'>
                              <td>
                                <p className='font-medium'>{r.name}</p>
                                <p className='mt-1 text-xs text-muted-foreground'>
                                  {t?.email || r.id}
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
                                  className={`rounded-full px-2 py-1 text-xs ${t?.state === 'available' ? 'bg-teal-500/10 text-teal-600' : 'bg-muted text-muted-foreground'}`}
                                >
                                  {stateLabel(t?.state || 'provisioning')}
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
                                  label='7 天'
                                  value={t?.utilization_7d}
                                  reset={t?.reset_7d}
                                />
                                <Quota
                                  label='5 小时'
                                  value={t?.utilization_5h}
                                  reset={t?.reset_5h}
                                />
                              </td>
                              <td>
                                {number(t?.inflight)} /{' '}
                                {t?.max_concurrency === 0
                                  ? '不限'
                                  : number(t?.max_concurrency)}
                              </td>
                              <td>{money(t?.today_cost)}</td>
                              <td>{money(t?.total_cost)}</td>
                              <td>
                                {t?.cache_hit_rate == null
                                  ? '—'
                                  : `${(t.cache_hit_rate * 100).toFixed(1)}%`}
                              </td>
                              <td className='text-xs'>{time(r.created_at)}</td>
                              <td>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={() => setSelected(r)}
                                >
                                  详情
                                </Button>
                                {canManage && r.vendor_id === vendor.id && (
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    disabled={busy}
                                    onClick={() => toggle(r)}
                                  >
                                    {r.status === 'paused' ? '恢复' : '暂停'}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </Table>
                    ))}
                  <div className='flex items-center justify-between border-t p-3 text-xs text-muted-foreground'>
                    <span>共 {rows.length} 条 · 每页 20 条</span>
                    <div className='flex items-center gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={page === 0}
                        onClick={() => setPage(page - 1)}
                      >
                        上一页
                      </Button>
                      {page + 1}
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={(page + 1) * 20 >= rows.length}
                        onClick={() => setPage(page + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </section>
              )}
              {view === 'usage' && (
                <section className={boxClass + ' space-y-4 p-4'}>
                  <div className='flex flex-wrap items-end gap-3'>
                    <Field title='开始日期'><Input type='date' value={billingStart} onChange={(e) => setBillingStart(e.target.value)} /></Field>
                    <Field title='结束日期'><Input type='date' value={billingEnd} onChange={(e) => setBillingEnd(e.target.value)} /></Field>
                    <select aria-label='供应商筛选' className={selectClass} value={scope} onChange={(e) => { setSupplierFilter(e.target.value); setPage(0) }}>
                      <option value=''>我的资源 · {vendor.name}</option>
                      {canBrowseSuppliers && <option value='all'>全部可见供应商</option>}
                      {canBrowseSuppliers && children.data?.filter((c) => c.id !== vendor.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <Button variant='outline' onClick={() => usage.refetch()} loading={usage.isFetching}>查询</Button>
                  </div>
                  <div className='grid gap-4 md:grid-cols-4'>
                    {[
                      ['总请求数', usage.data?.summary?.requests],
                      ['输入 Token', usage.data?.summary?.input_tokens],
                      ['输出 Token', usage.data?.summary?.output_tokens],
                      ['消耗金额', usage.data?.summary?.cost_usd == null ? '—' : money(Number(usage.data.summary.cost_usd))],
                    ].map(([label, value]) => <div key={String(label)} className='rounded-lg border p-4'><p className='text-xs text-muted-foreground'>{label}</p><p className='mt-2 text-xl font-semibold'>{value == null ? '—' : number(Number(value))}</p></div>)}
                  </div>
                  <State loading={usage.isPending} error={usage.error} empty={!usage.data?.trend?.length && !usage.data?.accounts?.length} retry={() => usage.refetch()} />
                  {!!usage.data?.trend?.length && <Table columns={['日期', '请求数', '输入 Token', '输出 Token', '消耗']}>
                    {usage.data.trend.map((row: any) => <tr key={row.date}><td>{row.date}</td><td>{number(row.requests)}</td><td>{number(row.input_tokens)}</td><td>{number(row.output_tokens)}</td><td>{money(row.cost_usd)}</td></tr>)}
                  </Table>}
                </section>
              )}
              {view === 'billing' && (
                <section className={boxClass + ' space-y-5 p-4'}>
                  <div className='grid gap-4 md:grid-cols-4'>
                    <div><p className='text-xs text-muted-foreground'>结算联系人</p><p className='mt-1'>{billing.data?.profile.contact_name || '—'}</p></div>
                    <div><p className='text-xs text-muted-foreground'>结算邮箱</p><p className='mt-1'>{billing.data?.profile.settlement_email || '—'}</p></div>
                    <div><p className='text-xs text-muted-foreground'>默认采购单价</p><p className='mt-1'>{billing.data?.profile.default_price_cny_per_usd ?? '—'} CNY/USD</p></div>
                    <div><p className='text-xs text-muted-foreground'>结算汇率</p><p className='mt-1'>{billing.data?.profile.fx_cny_per_usdt ?? '—'} CNY/USDT</p></div>
                  </div>
                  {canBrowseSuppliers && <div className='flex flex-wrap items-end gap-3 border-y py-4'>
                    <Field title='下游供应商'><select className={selectClass} value={billingChild} onChange={(e) => setBillingChild(e.target.value)}><option value=''>选择下游供应商</option>{children.data?.filter((c) => c.tier === 2).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                    <Field title='开始日期'><Input type='date' value={billingStart} onChange={(e) => setBillingStart(e.target.value)} /></Field>
                    <Field title='结束日期'><Input type='date' value={billingEnd} onChange={(e) => setBillingEnd(e.target.value)} /></Field>
                    <Button onClick={createSettlement} disabled={!billingChild || billingBusy} loading={billingBusy}>新增结算</Button>
                  </div>}
                  {billingError && <p role='alert' className='text-sm text-destructive'>{billingError}</p>}
                  <div><h2 className='mb-2 text-sm font-semibold'>上游对我的账单</h2><Table columns={['账单', '周期', '状态', '金额（USDT）', '合同']}>
                    {billing.data?.upstream.map((s) => <tr key={s.id}><td>{s.id}</td><td>{time(s.period_start)} — {time(s.period_end)}</td><td>{s.status}</td><td>{s.amount_usdt}</td><td>v{s.contract_version}</td></tr>)}
                  </Table></div>
                  {canBrowseSuppliers && <div><h2 className='mb-2 text-sm font-semibold'>我给下游的账单</h2><Table columns={['下游供应商', '周期', '状态', '金额（USDT）', '合同']}>
                    {billing.data?.downstream.map((s) => <tr key={s.id}><td>{s.counterparty_name || '—'}</td><td>{time(s.period_start)} — {time(s.period_end)}</td><td>{s.status}</td><td>{s.amount_usdt}</td><td>v{s.contract_version}</td></tr>)}
                  </Table></div>}
                </section>
              )}
              {view === 'vendors' && (
                <section className={boxClass}>
                  <div className='border-b p-4 text-sm'>
                    直属二级供应商：
                    {children.data?.filter((c) => c.tier === 2).length ??
                      '—'} /{' '}
                    {vendor.child_limit === 0 ? '不限制' : vendor.child_limit}
                  </div>
                  <State
                    loading={children.isPending}
                    error={children.error}
                    empty={!children.data?.some((c) => c.tier === 2)}
                    retry={() => children.refetch()}
                  />
                  <Table
                    columns={['名称', '邮箱', '状态', '账号额度', '代理额度']}
                  >
                    {children.data
                      ?.filter((c) => c.tier === 2)
                      .map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td>{c.email}</td>
                          <td>{stateLabel(c.status)}</td>
                          <td>{c.account_limit || '不限制'}</td>
                          <td>{c.proxy_limit || '不限制'}</td>
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
                  <Table columns={['操作', '资源', '时间']}>
                    {audit.data?.map((a) => (
                      <tr key={a.id}>
                        <td>{a.action}</td>
                        <td>{a.resource_type || '供应商'}</td>
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
                ? '添加账号'
                : dialog === 'proxy'
                  ? '添加代理'
                  : '新增二级供应商'}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'account'
                ? '填写账号资料，创建后进入等待授权状态。'
                : dialog === 'child'
                  ? '创建独立登录账号。二级供应商不能继续创建下级。'
                  : '保存供应商专属代理资料。'}
            </DialogDescription>
          </DialogHeader>
          <form className='space-y-4' onSubmit={submit}>
            {dialog === 'account' && (
              <>
                <Field title='账号名称'>
                  <Input
                    required
                    value={account.name}
                    onChange={(e) =>
                      setAccount({ ...account, name: e.target.value })
                    }
                  />
                </Field>
                <div className='grid gap-4 sm:grid-cols-2'>
                  <Field title='平台'>
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
                  <Field title='授权方式'>
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
                      <option value='manual'>手动凭据</option>
                    </select>
                  </Field>
                </div>
                <Field title='代理'>
                  <select
                    className={selectClass}
                    value={account.proxy_id}
                    onChange={(e) =>
                      setAccount({ ...account, proxy_id: e.target.value })
                    }
                  >
                    <option value=''>暂不绑定代理</option>
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
                  <summary className='cursor-pointer text-sm'>运行环境</summary>
                  <div className='mt-4 grid gap-4 sm:grid-cols-2'>
                    <Field title='环境'>
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
                    <Field title='语言'>
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
                            {l === 'C.UTF-8' ? '通用 C.UTF-8' : l}
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
                  <Field title='供应商名称'><Input required value={child.name} onChange={(e) => setChild({ ...child, name: e.target.value })} /></Field>
                  <Field title='邮箱'><Input type='email' required value={child.email} onChange={(e) => setChild({ ...child, email: e.target.value })} /></Field>
                  <Field title='用户名'><Input required value={child.username} onChange={(e) => setChild({ ...child, username: e.target.value })} /></Field>
                  <Field title='密码'><Input type='password' required value={child.password} onChange={(e) => setChild({ ...child, password: e.target.value })} /></Field>
                  <Field title='供应商编码'><Input required value={child.external_code} onChange={(e) => setChild({ ...child, external_code: e.target.value })} /></Field>
                  <Field title='联系人'><Input value={child.contact_name} onChange={(e) => setChild({ ...child, contact_name: e.target.value })} /></Field>
                  <Field title='结算邮箱'><Input type='email' value={child.settlement_email} onChange={(e) => setChild({ ...child, settlement_email: e.target.value })} /></Field>
                  <Field title='币安 ID'><Input value={child.binance_id} onChange={(e) => setChild({ ...child, binance_id: e.target.value })} /></Field>
                  <Field title='采购单价（CNY/USD）'><Input type='number' min='0.0001' step='0.0001' value={child.default_price_cny_per_usd} onChange={(e) => setChild({ ...child, default_price_cny_per_usd: Number(e.target.value) })} /></Field>
                  <Field title='结算汇率（CNY/USDT）'><Input type='number' min='0.0001' step='0.0001' value={child.fx_cny_per_usdt} onChange={(e) => setChild({ ...child, fx_cny_per_usdt: Number(e.target.value) })} /></Field>
                  <Field title='结算倍率'><Input type='number' min='0.0001' step='0.0001' value={child.default_multiplier} onChange={(e) => setChild({ ...child, default_multiplier: Number(e.target.value) })} /></Field>
                </div>
              </div>
            )}
            {dialog === 'proxy' && (
              <>
                <Field title='代理名称'>
                  <Input
                    required
                    value={proxy.name}
                    onChange={(e) =>
                      setProxy({ ...proxy, name: e.target.value })
                    }
                  />
                </Field>
                <Field title='代理地址'>
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
                name: '供应商名称',
                email: '邮箱',
                external_code: '供应商编码',
                username: '登录用户名',
                password: '登录密码',
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
                取消
              </Button>
              <Button type='submit' loading={busy}>
                创建
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
            <DialogDescription>账号资料和已采集用量</DialogDescription>
          </DialogHeader>
          {selected && (
            <dl className='grid grid-cols-[110px_1fr] gap-3 text-sm break-all'>
              {[
                ['账号 ID', selected.id],
                ['关联 VM', selected.telemetry?.vm_id || '预配中'],
                [
                  '状态',
                  stateLabel(selected.telemetry?.state || 'provisioning'),
                ],
                ['累计消耗', money(selected.telemetry?.total_cost)],
                ['请求数', number(selected.telemetry?.requests)],
                ['Token', number(selected.telemetry?.total_tokens)],
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

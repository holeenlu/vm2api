import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { redirect, useNavigate, useParams } from '@tanstack/react-router'
import { t as translate } from '@/i18n'
import type { MeResponse } from '@/types/panel-auth'
import type { Vm } from '@/types/panel-vm'
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
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import type { ImportKind, ImportMethod } from '@/lib/cred-type'
import { hasSession } from '@/lib/session'
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
import { LanguageSelect } from '@/components/language-select'
import { ThemeSwitch } from '@/components/theme-switch'
import { groupsQueryOptions } from '@/features/groups/queries'
import { CredentialPanel } from '@/features/vm/credential-panel'
import {
  VendorAccessCard,
  vendorAccessState,
  vendorAccessQueryOptions,
  vendorReturnPath,
  switchVendorAccount,
} from './access-state'
import { AccountCreateForm } from './account-create-form'
import { AccountDetails } from './account-details'
import { AccountWorkbench } from './account-workbench'
import { BillingWorkbench } from './billing-workbench'
import {
  viewLabel,
  allowedViews,
  stateLabel,
  time,
  type ViewKey,
  type Vendor,
  type Resource,
} from './portal-model'
import { ProxyAddressInput } from './proxy-input'
import { VendorUsageWorkbench } from './usage-workbench'

type Child = Vendor & { status: string }
const selectClass = 'h-9 rounded-lg border bg-background px-3 text-sm'
const boxClass = 'rounded-xl border bg-card shadow-sm'
const EMPTY_CHILD = {
  username: '',
  password: '',
}
const icons = {
  accounts: LayoutGrid,
  proxies: Globe2,
  vendors: Users,
  usage: BarChart3,
  billing: FileText,
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
  const signOut = useAuthStore((s) => s.signOut)
  const branding = useBranding()
  const [mobile, setMobile] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [refreshSeconds, setRefreshSeconds] = useState(60)
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Resource | null>(null)
  const [dialog, setDialog] = useState<'account' | 'proxy' | 'child' | null>(
    null
  )
  const [child, setChild] = useState(EMPTY_CHILD)
  const [proxy, setProxy] = useState({ name: '', endpoint: '' })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [createdAuth, setCreatedAuth] = useState<{
    vm: Vm
    kind?: ImportKind
    method?: ImportMethod
    codexMode?: 'oauth' | 'json'
  } | null>(null)
  const me = useQuery(vendorAccessQueryOptions())
  const access = vendorAccessState(me)
  const vendor = access === 'ready' ? me.data?.vendor : undefined
  const switchAccount = () =>
    switchVendorAccount(qc, signOut, () => {
      void nav({
        href: '/welcome',
        replace: true,
      })
    })
  const allowed = vendor ? allowedViews(vendor) : []
  const permitted = allowed.includes(view)
  const canBrowseSuppliers = allowed.includes('vendors')
  const scope = canBrowseSuppliers ? supplierFilter : ''
  const accountView = view === 'accounts'
  const proxyView = view === 'proxies'
  const resourcePath = view === 'usage' ? 'accounts' : view
  const resources = useQuery({
    queryKey: ['vendor', resourcePath, scope],
    queryFn: () => {
      const search = new URLSearchParams()
      if (scope) search.set('vendor_id', scope)
      if (resourcePath === 'accounts') search.set('archived', 'all')
      const query = search.toString()
      return api<Resource[]>(
        '/api/vendor/' + resourcePath + (query ? '?' + query : '')
      )
    },
    enabled:
      !!vendor && permitted && (accountView || proxyView || view === 'usage'),
    refetchInterval: refreshSeconds ? refreshSeconds * 1000 : false,
  })
  const proxies = useQuery({
    queryKey: ['vendor', 'proxies'],
    queryFn: () => api<Resource[]>('/api/vendor/proxies'),
    enabled: !!vendor && dialog === 'account',
  })
  const groupCatalog = useQuery({
    ...groupsQueryOptions(),
    queryKey: ['vendor', 'account-groups', vendor?.id || ''],
    staleTime: 0,
    refetchOnWindowFocus: false,
    enabled: !!vendor && dialog === 'account',
  })
  const children = useQuery({
    queryKey: ['vendor', 'vendors'],
    queryFn: () => api<Child[]>('/api/vendor/vendors'),
    enabled: !!vendor && canBrowseSuppliers,
  })
  const all = resources.data || []
  const rows = all.filter(
    (r) => !search || r.name.toLowerCase().includes(search.toLowerCase())
  )
  const canManage = !!vendor?.capabilities.includes('vendor.resource.manage')
  const canCreateAccount =
    canManage && !scope && !!vendor?.capabilities.includes('vendor.vm.create')
  const refresh = () => qc.invalidateQueries({ queryKey: ['vendor'] })
  const open = (kind: 'account' | 'proxy' | 'child') => {
    if (kind === 'child') setChild(EMPTY_CHILD)
    if (kind === 'proxy') setProxy({ name: '', endpoint: '' })
    setActionError('')
    setIdem(crypto.randomUUID())
    setDialog(kind)
  }
  const authorizeAccount = (r: Resource) => {
    const id = r.telemetry?.vm_id
    if (!id) {
      setActionError(t('accountVmMissing'))
      return
    }
    const kind = String(r.config.authorization_mode || '')
    setDialog('account')
    setCreatedAuth({
      vm: {
        id,
        name: r.name,
        platform: String(r.config.platform),
        family: r.config.platform === 'openai' ? 'codex' : undefined,
        can_import_credential: true,
      } as Vm,
      ...(r.config.platform === 'openai'
        ? {
            codexMode:
              kind === 'codex_account_file'
                ? ('json' as const)
                : ('oauth' as const),
          }
        : {
            kind:
              r.config.auth_method === 'apikey'
                ? ('apikey' as const)
                : r.config.auth_method === 'setup-token'
                  ? ('setup-token' as const)
                  : ('oauth' as const),
            method:
              r.config.auth_method === 'setup-token'
                ? ('session' as const)
                : ('link' as const),
          }),
    })
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
            : {}
      await api<{
        account?: Resource
        vm?: Resource
        runtime_boot?: { ok: boolean; error?: string }
      }>('/api/vendor/' + path, {
        method: 'POST',
        body: JSON.stringify({ ...body, idempotency_key: idem }),
      })
      setDialog(null)
      setChild(EMPTY_CHILD)
      setProxy({ name: '', endpoint: '' })
      setCreatedAuth(null)
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
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('updateFailed'))
      return false
    } finally {
      setBusy(false)
    }
  }
  const switchView = (key: ViewKey) => {
    setMobile(false)
    setSearch('')
    setPage(0)
    setActionError('')
    void nav({ to: '/vendor/$page', params: { page: key } })
  }
  if (access !== 'ready' || !vendor)
    return (
      <VendorAccessCard
        state={access === 'ready' ? 'error' : access}
        retrying={me.isFetching}
        onRetry={() => void me.refetch()}
        onSwitchAccount={switchAccount}
        onReturn={() =>
          void nav({
            href:
              access === 'expired'
                ? '/welcome'
                : vendorReturnPath(
                    qc.getQueryData<MeResponse>(['panel', 'me'])
                  ),
            replace: true,
          })
        }
      />
    )
  const groups: { label: string; keys: ViewKey[] }[] = [
    { label: t('resources'), keys: ['accounts', 'proxies', 'vendors'] },
    { label: t('statistics'), keys: ['usage', 'billing'] },
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
  const currentQuery = view === 'vendors' ? children : resources
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
            <LanguageSelect />
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
              onClick={switchAccount}
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
              {!accountView && view !== 'billing' && view !== 'usage' && (
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
              )}
              {actionError && (
                <p role='alert' className='text-sm text-destructive'>
                  {actionError}
                </p>
              )}
              {accountView && (
                <AccountWorkbench
                  rows={all}
                  vendorId={vendor.id}
                  vendorName={vendor.name}
                  scope={scope}
                  scopes={[
                    { id: '', name: t('myResources') + ' ' + vendor.name },
                    ...(canBrowseSuppliers
                      ? [
                          { id: 'all', name: t('allVisibleVendors') },
                          ...(children.data || [])
                            .filter((c) => c.id !== vendor.id)
                            .map((c) => ({ id: c.id, name: c.name })),
                        ]
                      : []),
                  ]}
                  loading={resources.isPending}
                  error={resources.error}
                  busy={busy}
                  updatedAt={resources.dataUpdatedAt}
                  canManage={canManage}
                  canCreate={canCreateAccount}
                  refreshSeconds={refreshSeconds}
                  onScope={setSupplierFilter}
                  onRefreshSeconds={setRefreshSeconds}
                  onRefresh={() => void refresh()}
                  onCreate={() => open('account')}
                  onDetail={setSelected}
                  onAuthorize={authorizeAccount}
                  onToggle={toggle}
                  canViewUsage={vendor.capabilities.includes(
                    'vendor.usage.read'
                  )}
                  onDelete={async (r) => {
                    await api('/api/vendor/accounts/' + r.id, {
                      method: 'DELETE',
                    })
                    await refresh()
                  }}
                />
              )}
              {proxyView && (
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
                        <>
                          <option value='all'>{t('allVisibleVendors')}</option>
                          {children.data
                            ?.filter((c) => c.id !== vendor.id)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </>
                      )}
                    </select>
                    <Input
                      className='max-w-xs'
                      aria-label={t('searchResources')}
                      placeholder={t('searchPlaceholder')}
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value)
                        setPage(0)
                      }}
                    />
                  </div>
                  <State
                    loading={resources.isPending}
                    error={resources.error}
                    empty={!rows.length}
                    retry={() => resources.refetch()}
                  />
                  {!resources.error && rows.length > 0 && (
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
                              : children.data?.find((c) => c.id === r.vendor_id)
                                  ?.name || r.vendor_id}
                          </td>
                          <td>{time(r.created_at)}</td>
                          <td>
                            {canManage && r.vendor_id === vendor.id && (
                              <Button
                                variant='ghost'
                                size='sm'
                                disabled={busy}
                                onClick={() => void toggle(r)}
                              >
                                {t(r.status === 'paused' ? 'resume' : 'pause')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}
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
                <VendorUsageWorkbench
                  scope={scope}
                  scopes={[
                    { id: '', name: t('myResources') + ' ' + vendor.name },
                    ...(canBrowseSuppliers
                      ? [
                          { id: 'all', name: t('allVisibleVendors') },
                          ...(children.data || [])
                            .filter((c) => c.id !== vendor.id)
                            .map((c) => ({ id: c.id, name: c.name })),
                        ]
                      : []),
                  ]}
                  accounts={all}
                  onScope={setSupplierFilter}
                />
              )}
              {view === 'billing' && (
                <BillingWorkbench
                  vendor={vendor}
                  children={children.data || []}
                  childrenLoading={canBrowseSuppliers && children.isPending}
                  childrenError={children.error}
                  onManageVendors={() => switchView('vendors')}
                />
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
                      t('loginUsername'),
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
                          <td>{stateLabel(c.status)}</td>
                          <td>{c.account_limit || t('unlimited')}</td>
                          <td>{c.proxy_limit || t('unlimited')}</td>
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
          if (!open && !busy) {
            setDialog(null)
            setCreatedAuth(null)
          }
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (
              document.activeElement?.getAttribute('role') === 'combobox' &&
              document.activeElement?.getAttribute('aria-expanded') === 'true'
            )
              event.preventDefault()
          }}
          className='max-h-[90svh] overflow-y-auto sm:max-w-xl'
        >
          <DialogHeader>
            <DialogTitle>
              {createdAuth
                ? t('authorizeAccount')
                : dialog === 'account'
                  ? t('addAccount')
                  : dialog === 'proxy'
                    ? t('addProxy')
                    : t('addVendor')}
            </DialogTitle>
            <DialogDescription>
              {createdAuth
                ? t('authorizeAccountDescription')
                : dialog === 'account'
                  ? t('accountDialogDescription')
                  : dialog === 'child'
                    ? t('childDialogDescription')
                    : t('proxyDialogDescription')}
            </DialogDescription>
          </DialogHeader>
          {dialog === 'account' && !createdAuth ? (
            <AccountCreateForm
              vendor={vendor}
              proxies={proxies.data || []}
              groups={groupCatalog.data?.items || []}
              onClose={() => setDialog(null)}
              onChanged={refresh}
              onBusyChange={setBusy}
              catalogLoading={groupCatalog.isFetching || proxies.isPending}
              catalogError={!!(groupCatalog.error || proxies.error)}
            />
          ) : createdAuth ? (
            <div className='space-y-4'>
              <CredentialPanel
                vm={createdAuth.vm}
                showConvert={false}
                initialKind={createdAuth.kind}
                initialMethod={createdAuth.method}
                initialCodexMode={createdAuth.codexMode}
                onCommitted={async () => {
                  setCreatedAuth(null)
                  setDialog(null)
                  await refresh()
                }}
              />
              <Button
                type='button'
                variant='outline'
                onClick={() => {
                  setCreatedAuth(null)
                  setDialog(null)
                }}
              >
                {t('finishLater')}
              </Button>
            </div>
          ) : (
            <form className='space-y-4' onSubmit={submit}>
              {dialog === 'child' && (
                <div className='space-y-4'>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <Field title={t('loginUsername')}>
                      <Input
                        required
                        autoComplete='off'
                        minLength={2}
                        maxLength={32}
                        value={child.username}
                        onChange={(e) =>
                          setChild({ ...child, username: e.target.value })
                        }
                      />
                    </Field>
                    <Field title={t('loginPassword')}>
                      <Input
                        type='password'
                        required
                        autoComplete='new-password'
                        minLength={8}
                        maxLength={128}
                        value={child.password}
                        onChange={(e) =>
                          setChild({ ...child, password: e.target.value })
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
                    <ProxyAddressInput
                      required
                      value={proxy.endpoint}
                      onChange={(endpoint) => setProxy({ ...proxy, endpoint })}
                    />
                  </Field>
                </>
              )}
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
          )}
        </DialogContent>
      </Dialog>
      {selected && (
        <AccountDetails
          resource={selected}
          canManage={canManage && selected.vendor_id === vendor.id}
          onClose={() => setSelected(null)}
          onChanged={() => void resources.refetch()}
        />
      )}
    </div>
  )
}
export const vendorRouteBeforeLoad = async () => {
  if (!hasSession())
    throw redirect({ to: '/login', search: { redirect: '/vendor' } })
}

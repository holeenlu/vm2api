import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { redirect, useNavigate, useParams } from '@tanstack/react-router'
import { t as translate } from '@/i18n'
import type { MeResponse } from '@/types/panel-auth'
import type { Vm } from '@/types/panel-vm'
import {
  Activity,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import type { ImportKind, ImportMethod } from '@/lib/cred-type'
import { hasSession } from '@/lib/session'
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
import { VendorPortalLayout } from './portal-layout'
import {
  viewLabel,
  allowedViews,
  stateLabel,
  type ViewKey,
  type Vendor,
  type Resource,
} from './portal-model'
import { ProxyAddressInput } from './proxy-input'
import { VendorUsageWorkbench } from './usage-workbench'

type Child = Vendor & { status: string }
const selectClass =
  'h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'
const boxClass = 'rounded-xl border bg-card shadow-sm'
const EMPTY_CHILD = {
  username: '',
  password: '',
}

type VendorProxyConfig = Resource['config'] & {
  protocol?: string
  host?: string
  endpoint?: string
  has_auth?: boolean
  pool_status?: string
  pool_enabled?: boolean
  latency_ms?: number | null
  quality?: { score?: number; grade?: string } | null
  geo?: { country?: string; city?: string } | null
  bound_count?: number
  bind_limit?: number
  available?: boolean
}

const proxyConfig = (resource: Resource) => resource.config as VendorProxyConfig

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
        <tbody className='divide-y [&_td]:px-4 [&_td]:py-4 [&_tr]:transition-colors [&_tr]:hover:bg-muted/50'>
          {children}
        </tbody>
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
  const [refreshSeconds, setRefreshSeconds] = useState(60)
  const [search, setSearch] = useState('')
  const [proxyProtocol, setProxyProtocol] = useState('all')
  const [proxyStatus, setProxyStatus] = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [proxyPage, setProxyPage] = useState(0)
  const [proxySize, setProxySize] = useState(20)
  const [selected, setSelected] = useState<Resource | null>(null)
  const [dialog, setDialog] = useState<'account' | 'proxy' | 'child' | null>(
    null
  )
  const [child, setChild] = useState(EMPTY_CHILD)
  const [proxy, setProxy] = useState({ name: '', endpoint: '' })
  const [editingProxy, setEditingProxy] = useState<Resource | null>(null)
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
    queryKey: ['vendor', resourcePath, proxyView ? '' : scope],
    queryFn: () => {
      const search = new URLSearchParams()
      const resourceScope = proxyView ? '' : scope
      if (resourceScope) search.set('vendor_id', resourceScope)
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
  const rows = all.filter((r) => {
    if (!search) return true
    const config = proxyConfig(r)
    return [r.name, r.id, r.vendor_id, config.host, config.endpoint]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase())
  })
  const proxyRows = (proxyView ? all : rows).filter((r) => {
    const config = proxyConfig(r)
    const poolStatus = config.pool_status || r.status
    return (
      (proxyProtocol === 'all' || config.protocol === proxyProtocol) &&
      (proxyStatus === 'all' ||
        r.status === proxyStatus ||
        poolStatus === proxyStatus)
    )
  })
  const proxyMetrics = {
    total: proxyRows.length,
    enabled: proxyRows.filter((r) => proxyConfig(r).pool_enabled).length,
    available: proxyRows.filter((r) => proxyConfig(r).available).length,
    bound: proxyRows.reduce(
      (sum, r) => sum + Number(proxyConfig(r).bound_count || 0),
      0
    ),
  }
  const proxyCurrentPage = Math.min(
    proxyPage,
    Math.max(0, Math.ceil(proxyRows.length / proxySize) - 1)
  )
  const proxyPageRows = proxyRows.slice(
    proxyCurrentPage * proxySize,
    (proxyCurrentPage + 1) * proxySize
  )
  const proxyStatusLabel = (status: string) => {
    const key = 'supplierAdmin:proxyStatus_' + status
    const label = t(key)
    return label === key ? stateLabel(status) : label
  }
  const canManage = !!vendor?.capabilities.includes('vendor.resource.manage')
  const canCreateAccount =
    canManage && !scope && !!vendor?.capabilities.includes('vendor.vm.create')
  const refresh = () => qc.invalidateQueries({ queryKey: ['vendor'] })
  const open = (kind: 'account' | 'proxy' | 'child') => {
    if (kind === 'child') setChild(EMPTY_CHILD)
    if (kind === 'proxy') {
      setProxy({ name: '', endpoint: '' })
      setEditingProxy(null)
    }
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
      const requestBody = editingProxy
        ? (() => {
            const next = { name: proxy.name } as {
              name: string
              endpoint?: string
            }
            const currentEndpoint = String(
              proxyConfig(editingProxy).endpoint || ''
            ).trim()
            const nextEndpoint = proxy.endpoint.trim()
            if (nextEndpoint && nextEndpoint !== currentEndpoint)
              next.endpoint = nextEndpoint
            return next
          })()
        : { ...body, idempotency_key: idem }
      await api<{
        account?: Resource
        vm?: Resource
        runtime_boot?: { ok: boolean; error?: string }
      }>(
        editingProxy
          ? '/api/vendor/proxies/' + editingProxy.id
          : '/api/vendor/' + path,
        {
          method: editingProxy ? 'PATCH' : 'POST',
          body: JSON.stringify(requestBody),
        }
      )
      setDialog(null)
      setChild(EMPTY_CHILD)
      setProxy({ name: '', endpoint: '' })
      setEditingProxy(null)
      setCreatedAuth(null)
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const proxyAction = async (r: Resource, operation: string) => {
    setBusy(true)
    setActionError('')
    try {
      await api(`/api/vendor/proxies/${r.id}/${operation}`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }
  const proxyBatchAction = async (
    operation: 'probe' | 'quality-check' | 'geo'
  ) => {
    setBusy(true)
    setActionError('')
    try {
      await api(`/api/vendor/proxies/${operation}`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }
  const editProxy = (r: Resource) => {
    const config = proxyConfig(r)
    setProxy({
      name: r.name,
      endpoint: String(config.endpoint || ''),
    })
    setEditingProxy(r)
    setActionError('')
    setDialog('proxy')
  }
  const switchView = (key: ViewKey) => {
    setSearch('')
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
  const currentQuery = view === 'vendors' ? children : resources
  return (
    <>
      <VendorPortalLayout
        vendor={vendor}
        view={view}
        onView={switchView}
        onSignOut={switchAccount}
      >
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
                  <h1 className='text-2xl font-bold tracking-tight'>
                    {viewLabel(view)}
                  </h1>
                  <p className='mt-1 text-sm text-muted-foreground'>
                    {scope ? t('scopeReadOnly') : t('manageResources')}
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    variant='outline'
                    onClick={refresh}
                    loading={currentQuery.isFetching}
                  >
                    <RefreshCw />
                    {t('refresh')}
                  </Button>
                  {proxyView && canManage && (
                    <>
                      <Button
                        variant='outline'
                        disabled={busy || !proxyRows.length}
                        onClick={() => void proxyBatchAction('probe')}
                      >
                        <Activity />
                        {t('supplierAdmin:probeAll')}
                      </Button>
                      <Button
                        variant='outline'
                        disabled={busy || !proxyRows.length}
                        onClick={() => void proxyBatchAction('quality-check')}
                      >
                        <ShieldCheck />
                        {t('supplierAdmin:qualityAll')}
                      </Button>
                      <Button
                        variant='outline'
                        disabled={busy || !proxyRows.length}
                        onClick={() => void proxyBatchAction('geo')}
                      >
                        <Globe />
                        {t('supplierAdmin:geoAll')}
                      </Button>
                      <Button onClick={() => open('proxy')}>
                        <Plus />
                        {t('addProxy')}
                      </Button>
                    </>
                  )}
                  {view === 'vendors' && (
                    <Button onClick={() => open('child')}>
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
                onRefresh={refresh}
                onCreate={() => open('account')}
                onDetail={setSelected}
                onAuthorize={authorizeAccount}
                onSetStatus={(row, status) =>
                  api('/api/vendor/accounts/' + row.id, {
                    method: 'PATCH',
                    body: JSON.stringify({ status }),
                  })
                }
                canViewUsage={vendor.capabilities.includes('vendor.usage.read')}
                onDelete={async (r) => {
                  await api('/api/vendor/accounts/' + r.id, {
                    method: 'DELETE',
                  })
                  await refresh()
                }}
              />
            )}
            {proxyView && (
              <div className='space-y-5'>
                <div className='grid grid-cols-2 gap-3 xl:grid-cols-4'>
                  {[
                    ['supplierAdmin:proxyTotal', proxyMetrics.total],
                    ['supplierAdmin:proxyEnabled', proxyMetrics.enabled],
                    ['supplierAdmin:proxyAvailable', proxyMetrics.available],
                    ['supplierAdmin:proxyBound', proxyMetrics.bound],
                  ].map(([label, value]) => (
                    <div
                      key={String(label)}
                      className='min-w-0 rounded-xl border bg-card p-4 shadow-sm'
                    >
                      <div className='text-sm text-muted-foreground'>
                        {t(String(label))}
                      </div>
                      <div className='mt-2 text-2xl font-semibold tabular-nums'>
                        {Number(value).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
                <div className='flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4'>
                  <select
                    aria-label={t('supplierAdmin:allProtocols')}
                    className={selectClass}
                    value={proxyProtocol}
                    onChange={(e) => {
                      setProxyProtocol(e.target.value)
                      setProxyPage(0)
                    }}
                  >
                    <option value='all'>
                      {t('supplierAdmin:allProtocols')}
                    </option>
                    {['http', 'https', 'socks5', 'socks5h'].map((value) => (
                      <option value={value} key={value}>
                        {value.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('supplierAdmin:allStatuses')}
                    className={selectClass}
                    value={proxyStatus}
                    onChange={(e) => {
                      setProxyStatus(e.target.value)
                      setProxyPage(0)
                    }}
                  >
                    <option value='all'>
                      {t('supplierAdmin:allStatuses')}
                    </option>
                    {[
                      'active',
                      'paused',
                      'disabled',
                      'ok',
                      'fail',
                      'dead',
                      'unknown',
                    ].map((value) => (
                      <option value={value} key={value}>
                        {t('supplierAdmin:proxyStatus_' + value)}
                      </option>
                    ))}
                  </select>
                </div>
                {resources.isPending || resources.error ? (
                  <div className='rounded-xl border bg-card'>
                    <State
                      loading={resources.isPending}
                      error={resources.error}
                      empty={false}
                      retry={() => resources.refetch()}
                    />
                  </div>
                ) : (
                  <div className='overflow-x-auto rounded-xl border bg-card'>
                    <table className='w-full min-w-[1250px] text-sm [&_td]:whitespace-nowrap'>
                      <thead className='border-b bg-muted/40'>
                        <tr>
                          {[
                            'name',
                            'supplier',
                            'protocol',
                            'endpoint',
                            'status',
                            'latency',
                            'location',
                            'binding',
                            'actions',
                          ].map((key) => (
                            <th
                              className='px-4 py-3 text-left font-medium text-muted-foreground'
                              key={key}
                            >
                              {t(
                                key === 'protocol'
                                  ? 'common:protocol'
                                  : 'supplierAdmin:' + key
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className='divide-y'>
                        {proxyPageRows.map((r) => {
                          const config = proxyConfig(r)
                          const poolStatus = config.pool_status || 'unknown'
                          return (
                            <tr
                              key={r.id}
                              className='align-top hover:bg-muted/20'
                            >
                              <td className='p-4'>
                                <div className='font-medium'>{r.name}</div>
                                <div className='mt-1 text-xs text-muted-foreground'>
                                  {r.id}
                                </div>
                              </td>
                              <td className='p-4'>
                                {r.vendor_id === vendor.id
                                  ? vendor.name
                                  : children.data?.find(
                                      (c) => c.id === r.vendor_id
                                    )?.name || r.vendor_id}
                              </td>
                              <td className='p-4'>
                                {String(config.protocol || '—').toUpperCase()}
                              </td>
                              <td className='p-4'>
                                <code>{String(config.endpoint || '—')}</code>
                                {config.has_auth && (
                                  <div className='text-xs text-muted-foreground'>
                                    {t('supplierAdmin:credentialsConfigured')}
                                  </div>
                                )}
                              </td>
                              <td className='p-4'>
                                <div>{proxyStatusLabel(poolStatus)}</div>
                                <div className='text-xs text-muted-foreground'>
                                  {config.pool_enabled
                                    ? t('supplierAdmin:enabled')
                                    : t('supplierAdmin:disabled')}
                                </div>
                              </td>
                              <td className='p-4'>
                                {config.latency_ms == null
                                  ? '—'
                                  : `${config.latency_ms} ms`}
                                <div className='text-xs text-muted-foreground'>
                                  {config.quality?.grade
                                    ? `${config.quality.grade} / ${config.quality.score ?? '—'}`
                                    : '—'}
                                </div>
                              </td>
                              <td className='p-4'>
                                {config.geo?.country || '—'}
                                {config.geo?.city ? (
                                  <div className='text-xs text-muted-foreground'>
                                    {config.geo.city}
                                  </div>
                                ) : null}
                              </td>
                              <td className='p-4 tabular-nums'>
                                {config.bound_count || 0} /{' '}
                                {config.bind_limit || '—'}
                              </td>
                              <td className='p-4'>
                                {canManage && r.vendor_id === vendor.id && (
                                  <div className='flex flex-wrap gap-1'>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      disabled={busy}
                                      onClick={() =>
                                        void proxyAction(r, 'probe')
                                      }
                                      title={t('supplierAdmin:probe')}
                                    >
                                      <Activity className='size-4' />
                                    </Button>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      disabled={busy}
                                      onClick={() =>
                                        void proxyAction(r, 'quality-check')
                                      }
                                      title={t('supplierAdmin:quality')}
                                    >
                                      <ShieldCheck className='size-4' />
                                    </Button>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      disabled={busy}
                                      onClick={() => void proxyAction(r, 'geo')}
                                      title={t('proxies:checkGeo')}
                                    >
                                      <Globe className='size-4' />
                                    </Button>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      disabled={busy}
                                      onClick={() => editProxy(r)}
                                      title={t('proxies:edit')}
                                    >
                                      <Pencil className='size-4' />
                                    </Button>
                                    <Button
                                      size='sm'
                                      variant='outline'
                                      disabled={busy}
                                      onClick={() => {
                                        if (
                                          window.confirm(
                                            t(
                                              'supplierAdmin:deleteProxyConfirm'
                                            )
                                          )
                                        )
                                          void proxyAction(r, 'archive')
                                      }}
                                      title={t('proxies:delete')}
                                    >
                                      <Trash2 className='size-4' />
                                    </Button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {!proxyRows.length && (
                      <p className='py-10 text-center text-muted-foreground'>
                        {t('noRecords')}
                      </p>
                    )}
                    <div className='flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground'>
                      <div className='flex items-center gap-4'>
                        <span>
                          {t('wb.pagination', {
                            from: proxyRows.length
                              ? proxyCurrentPage * proxySize + 1
                              : 0,
                            to: Math.min(
                              (proxyCurrentPage + 1) * proxySize,
                              proxyRows.length
                            ),
                            total: proxyRows.length,
                          })}
                        </span>
                        <label className='flex items-center gap-2'>
                          {t('wb.pageSize')}
                          <select
                            className={selectClass}
                            value={proxySize}
                            onChange={(e) => {
                              setProxySize(Number(e.target.value))
                              setProxyPage(0)
                            }}
                          >
                            {[10, 20, 50, 100].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={proxyCurrentPage === 0}
                          onClick={() => setProxyPage(proxyCurrentPage - 1)}
                        >
                          {t('previous')}
                        </Button>
                        <span className='rounded border border-primary/40 bg-primary/10 px-3 py-2 text-primary'>
                          {proxyCurrentPage + 1}
                        </span>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={
                            (proxyCurrentPage + 1) * proxySize >=
                            proxyRows.length
                          }
                          onClick={() => setProxyPage(proxyCurrentPage + 1)}
                        >
                          {t('next')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
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
      </VendorPortalLayout>
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
                    ? editingProxy
                      ? t('supplierAdmin:editProxy')
                      : t('addProxy')
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
    </>
  )
}
export const vendorRouteBeforeLoad = async () => {
  if (!hasSession())
    throw redirect({ to: '/login', search: { redirect: '/vendor' } })
}

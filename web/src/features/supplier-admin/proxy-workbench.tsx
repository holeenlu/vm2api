import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CheckCircle2,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import {
  ROOT,
  amount,
  selectClass,
  type Supplier,
  type SupplierProxy,
} from './model'
import { proxyEditPayload } from './proxy-workbench-model'

function proxyConfig(proxy: SupplierProxy) {
  return proxy.config as SupplierProxy['config']
}

export function SupplierProxyWorkbench({
  suppliers: suppliedSuppliers,
  initialVendor = 'all',
}: {
  suppliers?: Supplier[]
  initialVendor?: string
}) {
  const { t } = useTranslation('supplierAdmin')
  const qc = useQueryClient()
  const [vendorId, setVendorId] = useState(initialVendor)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [protocol, setProtocol] = useState('all')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const [editor, setEditor] = useState<SupplierProxy | 'new' | null>(null)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const supplierQuery = useQuery({
    queryKey: ['supplier-admin', 'suppliers'],
    queryFn: () => api<Supplier[]>(ROOT),
    enabled: !suppliedSuppliers?.length,
  })
  const suppliers = suppliedSuppliers?.length
    ? suppliedSuppliers
    : supplierQuery.data || []
  const query = new URLSearchParams({
    vendor_id: vendorId,
    include_children: 'true',
  }).toString()
  const list = useQuery({
    queryKey: ['supplier-admin', 'proxies', query],
    queryFn: () => api<SupplierProxy[]>(`${ROOT}/proxies?${query}`),
    refetchInterval: 15000,
  })
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (list.data || []).filter((proxy) => {
      const config = proxyConfig(proxy)
      const text = [
        proxy.name,
        proxy.id,
        proxy.vendor_id,
        config.host,
        config.endpoint,
      ]
        .join(' ')
        .toLowerCase()
      const state = config.pool_enabled ? proxy.status : 'disabled'
      return (
        (!needle || text.includes(needle)) &&
        (status === 'all' ||
          proxy.status === status ||
          state === status ||
          config.pool_status === status) &&
        (protocol === 'all' || config.protocol === protocol)
      )
    })
  }, [list.data, protocol, search, status])
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / size) - 1)
  )
  const pageRows = rows.slice(currentPage * size, (currentPage + 1) * size)
  const names = new Map(
    suppliers.map((supplier) => [supplier.id, supplier.name])
  )
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['supplier-admin'] })
  }
  const action = async (proxy: SupplierProxy, operation: string) => {
    setBusyId(`${proxy.id}:${operation}`)
    setError('')
    try {
      await api(`${ROOT}/proxies/${proxy.id}/${operation}`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }
  const bulk = async (operation: 'probe' | 'quality-check' | 'geo') => {
    setBusyId(`bulk:${operation}`)
    setError('')
    try {
      await api(`${ROOT}/proxies/${operation}`, {
        method: 'POST',
        body: JSON.stringify({ vendor_id: vendorId }),
      })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId('')
    }
  }
  const metrics = {
    total: rows.length,
    enabled: rows.filter((row) => proxyConfig(row).pool_enabled).length,
    available: rows.filter((row) => proxyConfig(row).available).length,
    bound: rows.reduce(
      (sum, row) => sum + Number(proxyConfig(row).bound_count || 0),
      0
    ),
  }
  return (
    <PageHeader
      title={t('proxies')}
      description={t('proxiesDescription')}
      fluid
      extra={
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='outline'
            onClick={() => void refresh()}
            aria-label={t('refresh')}
          >
            <RefreshCw className='size-4' />
          </Button>
          <Button
            variant='outline'
            disabled={busyId !== '' || !rows.length}
            onClick={() => void bulk('probe')}
          >
            <Activity className='size-4' />
            {t('probeAll')}
          </Button>
          <Button
            variant='outline'
            disabled={busyId !== '' || !rows.length}
            onClick={() => void bulk('quality-check')}
          >
            <ShieldCheck className='size-4' />
            {t('qualityAll')}
          </Button>
          <Button
            variant='outline'
            disabled={busyId !== '' || !rows.length}
            onClick={() => void bulk('geo')}
          >
            <Globe className='size-4' />
            {t('geoAll')}
          </Button>
          <Button onClick={() => setEditor('new')}>
            <Plus className='size-4' />
            {t('addProxy')}
          </Button>
        </div>
      }
    >
      <div className='space-y-5'>
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          {[
            [t('proxyTotal'), metrics.total],
            [t('proxyEnabled'), metrics.enabled],
            [t('proxyAvailable'), metrics.available],
            [t('proxyBound'), metrics.bound],
          ].map(([label, value]) => (
            <div key={String(label)} className='rounded-xl border bg-card p-5'>
              <div className='text-sm text-muted-foreground'>{label}</div>
              <div className='mt-2 text-2xl font-semibold tabular-nums'>
                {amount(Number(value))}
              </div>
            </div>
          ))}
        </div>
        <div className='flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4'>
          <select
            className={selectClass}
            value={vendorId}
            onChange={(e) => {
              setVendorId(e.target.value)
              setPage(0)
            }}
          >
            <option value='all'>{t('allSuppliers')}</option>
            {suppliers.map((supplier) => (
              <option value={supplier.id} key={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
          <Input
            className='max-w-sm flex-1'
            placeholder={t('searchProxy')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
          <select
            className={selectClass}
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value)
              setPage(0)
            }}
          >
            <option value='all'>{t('allProtocols')}</option>
            {['http', 'https', 'socks5', 'socks5h'].map((value) => (
              <option value={value} key={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(0)
            }}
          >
            <option value='all'>{t('allStatuses')}</option>
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
                {t(`proxyStatus_${value}`)}
              </option>
            ))}
          </select>
        </div>
        {(error || list.error) && (
          <p role='alert' className='text-sm text-destructive'>
            {error || list.error?.message}
          </p>
        )}
        {list.isPending ? (
          <p className='p-8 text-muted-foreground'>{t('loading')}</p>
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
                      {t(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className='divide-y'>
                {pageRows.map((proxy) => {
                  const config = proxyConfig(proxy)
                  return (
                    <tr key={proxy.id} className='align-top hover:bg-muted/20'>
                      <td className='p-4'>
                        <div className='font-medium'>{proxy.name}</div>
                        <div className='mt-1 text-xs text-muted-foreground'>
                          {proxy.id}
                        </div>
                      </td>
                      <td className='p-4'>
                        {names.get(proxy.vendor_id) || proxy.vendor_id}
                      </td>
                      <td className='p-4'>
                        {String(config.protocol || '—').toUpperCase()}
                      </td>
                      <td className='p-4'>
                        <code>{String(config.endpoint || '—')}</code>
                        {config.has_auth && (
                          <div className='text-xs text-muted-foreground'>
                            {t('credentialsConfigured')}
                          </div>
                        )}
                      </td>
                      <td className='p-4'>
                        <div>
                          {t(
                            `proxyStatus_${config.pool_status || proxy.status}`
                          )}
                        </div>
                        <div className='text-xs text-muted-foreground'>
                          {config.pool_enabled ? t('enabled') : t('disabled')}
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
                        {config.bound_count || 0} / {config.bind_limit || '—'}
                      </td>
                      <td className='p-4'>
                        <div className='flex flex-wrap gap-1'>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busyId !== ''}
                            onClick={() => void action(proxy, 'probe')}
                            title={t('probe')}
                          >
                            <Activity className='size-4' />
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busyId !== ''}
                            onClick={() => void action(proxy, 'quality-check')}
                            title={t('quality')}
                          >
                            <ShieldCheck className='size-4' />
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busyId !== ''}
                            onClick={() =>
                              void action(
                                proxy,
                                config.pool_enabled ? 'disable' : 'enable'
                              )
                            }
                            title={
                              config.pool_enabled ? t('disable') : t('enable')
                            }
                          >
                            {config.pool_enabled ? (
                              <XCircle className='size-4' />
                            ) : (
                              <CheckCircle2 className='size-4' />
                            )}
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busyId !== ''}
                            onClick={() => setEditor(proxy)}
                            title={t('edit')}
                          >
                            <Pencil className='size-4' />
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={busyId !== ''}
                            onClick={() => {
                              if (window.confirm(t('archiveConfirm')))
                                void action(proxy, 'archive')
                            }}
                            title={t('archive')}
                          >
                            <Trash2 className='size-4' />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!rows.length && (
              <p className='py-10 text-center text-muted-foreground'>
                {t('empty')}
              </p>
            )}
            <div className='flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground'>
              <div className='flex items-center gap-4'>
                <span>
                  {t('pagination', {
                    from: rows.length ? currentPage * size + 1 : 0,
                    to: Math.min((currentPage + 1) * size, rows.length),
                    total: rows.length,
                  })}
                </span>
                <label className='flex items-center gap-2'>
                  {t('pageSize')}
                  <select
                    className={selectClass}
                    value={size}
                    onChange={(e) => {
                      setSize(Number(e.target.value))
                      setPage(0)
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
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  {t('previous')}
                </Button>
                <span className='rounded border border-primary/40 bg-primary/10 px-3 py-2 text-primary'>
                  {currentPage + 1}
                </span>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={(currentPage + 1) * size >= rows.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      {editor && (
        <ProxyEditor
          proxy={editor === 'new' ? undefined : editor}
          suppliers={suppliers}
          initialVendor={vendorId}
          close={() => setEditor(null)}
          saved={refresh}
        />
      )}
    </PageHeader>
  )
}

function ProxyEditor({
  proxy,
  suppliers,
  initialVendor,
  close,
  saved,
}: {
  proxy?: SupplierProxy
  suppliers: Supplier[]
  initialVendor: string
  close: () => void
  saved: () => Promise<void>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [vendorId, setVendorId] = useState(
    proxy?.vendor_id || (initialVendor === 'all' ? '' : initialVendor)
  )
  const [name, setName] = useState(proxy?.name || '')
  const [endpoint, setEndpoint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (!proxy) {
        await api(`${ROOT}/proxies?vendor_id=${encodeURIComponent(vendorId)}`, {
          method: 'POST',
          body: JSON.stringify({ name, config: { endpoint } }),
        })
      } else {
        await api(`${ROOT}/proxies/${proxy.id}`, {
          method: 'PATCH',
          body: JSON.stringify(proxyEditPayload(name, endpoint)),
        })
      }
      await saved()
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(proxy ? 'editProxy' : 'addProxy')}</DialogTitle>
          <DialogDescription>{t('proxyWorkbenchHint')}</DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4'
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {!proxy && (
            <label className='grid gap-2 text-sm'>
              {t('supplier')}
              <select
                required
                className={selectClass}
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
              >
                <option value=''>{t('selectSupplier')}</option>
                {suppliers
                  .filter((s) => s.status === 'active')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className='grid gap-2 text-sm'>
            {t('name')}
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className='grid gap-2 text-sm'>
            {t('endpoint')}
            <Input
              required={!proxy}
              placeholder='socks5://user:password@host:1080'
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <span className='text-xs text-muted-foreground'>
              {t(proxy ? 'proxyEditEndpointHint' : 'proxyCredentialHint')}
            </span>
          </label>
          {error && (
            <p role='alert' className='text-sm text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={close}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button type='submit' disabled={busy || !vendorId}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

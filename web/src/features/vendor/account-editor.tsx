import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  editableGroupOptions,
  type Resource,
  type VendorAccountDetail,
} from './portal-model'
import { AccountProxyInput } from './proxy-input'

export function AccountEditor({
  resource,
  apiBase = '/api/vendor/accounts',
  onClose,
  onChanged,
}: {
  resource: Resource
  apiBase?: string
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('vendor')
  const query = useQuery({
    queryKey: ['vendor', apiBase, 'account', resource.id],
    queryFn: () => api<VendorAccountDetail>(apiBase + '/' + resource.id),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })
  const proxies = useQuery({
    queryKey: ['vendor', 'proxies', resource.vendor_id],
    queryFn: () =>
      api<Resource[]>(
        apiBase.startsWith('/api/admin/')
          ? '/api/admin/vendors/proxies?vendor_id=' +
              encodeURIComponent(resource.vendor_id)
          : '/api/vendor/proxies'
      ),
    refetchOnWindowFocus: false,
  })
  const groups = useQuery({
    queryKey: ['vendor', apiBase, 'account-groups', resource.id],
    queryFn: () =>
      api<{
        items: {
          id: number
          name: string
          platform: string
          supported_platforms: string[]
        }[]
      }>(apiBase + '/' + resource.id + '/groups'),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
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
        className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'
      >
        <DialogHeader>
          <DialogTitle>
            {t('wb.editAccount')} · {resource.name}
          </DialogTitle>
          <DialogDescription>{t('details.editHelp')}</DialogDescription>
        </DialogHeader>
        {query.isPending || proxies.isPending || groups.isPending ? (
          <p>{t('loading')}</p>
        ) : query.error || proxies.error || groups.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {query.error?.message ||
              proxies.error?.message ||
              groups.error?.message}
          </p>
        ) : (
          query.data && (
            <EditorForm
              detail={query.data}
              apiBase={apiBase}
              proxies={proxies.data || []}
              groups={groups.data?.items || []}
              onClose={onClose}
              onChanged={onChanged}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  )
}
function EditorForm({
  apiBase,
  detail,
  proxies,
  groups,
  onClose,
  onChanged,
}: {
  detail: VendorAccountDetail
  apiBase: string
  proxies: Resource[]
  groups: {
    id: number
    name: string
    platform: string
    supported_platforms?: string[]
  }[]
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('vendor')
  const [name, setName] = useState(detail.name),
    [notes, setNotes] = useState(detail.notes || '')
  const [groupIds, setGroupIds] = useState(
      (detail.groups || []).map((g) => g.id)
    ),
    [groupsChanged, setGroupsChanged] = useState(false)
  const [source, setSource] = useState('auto'),
    [proxyChanged, setProxyChanged] = useState(false)
  const [proxyId, setProxyId] = useState(String(detail.config.proxy_id || '')),
    [endpoint, setEndpoint] = useState(''),
    [region, setRegion] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const allowedGroups = groups.filter((g) =>
    g.supported_platforms?.includes(String(detail.config.platform))
  )
  const regions = [
    ...new Map(
      proxies
        .filter((p) => p.config.region)
        .map((p) => [
          String(p.config.region),
          String(p.config.region_name || p.config.region),
        ])
    ).entries(),
  ]
  const options = proxies.filter(
    (p) =>
      p.status === 'active' &&
      (!region || p.config.region === region) &&
      (p.config.available !== false || p.id === detail.config.proxy_id)
  )
  const save = async () => {
    if (busy) return
    if (proxyChanged && source === 'existing' && !proxyId) {
      setError(t('selectSavedProxy'))
      return
    }
    if (proxyChanged && source === 'new' && !endpoint.trim()) {
      setError(t('proxyRequiredForBoot'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = {
        name,
        notes,
        expected_updated_at: detail.updated_at,
        ...(groupsChanged
          ? {
              group_ids: groupIds,
              expected_group_version: detail.group_version,
            }
          : {}),
        ...(proxyChanged
          ? {
              proxy_source: source,
              ...(source === 'new'
                ? { proxy_endpoint: endpoint }
                : source === 'existing'
                  ? { proxy_id: proxyId }
                  : { proxy_region: region }),
            }
          : {}),
      }
      const updated = await api<Resource & { runtime_apply?: { ok: boolean } }>(
        apiBase + '/' + detail.id,
        { method: 'PATCH', body: JSON.stringify(body) }
      )
      if (updated.runtime_apply?.ok === false)
        toast.warning(t('details.applyPending'))
      onClose()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className='space-y-5'
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <fieldset className='space-y-5' disabled={busy}>
        <label className='grid gap-2 text-sm font-medium'>
          {t('accountName')}
          <Input
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className='grid gap-2 text-sm font-medium'>
          {t('wb.column.notes')}
          <textarea
            className='min-h-20 rounded-lg border bg-background p-3'
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <section className='space-y-4 rounded-xl border bg-muted/10 p-4'>
          <h3 className='text-sm font-semibold'>{t('details.commonConfig')}</h3>
          <div className='grid gap-2 text-sm'>
            <span>{t('groups')}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type='button'
                  variant='outline'
                  className='justify-between'
                >
                  {[
                    ...new Map(
                      [...(detail.groups || []), ...allowedGroups].map((g) => [
                        g.id,
                        g,
                      ])
                    ).values(),
                  ]
                    .filter((g) => groupIds.includes(g.id))
                    .map((g) => g.name)
                    .join('、') || t('groupsHelp')}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className='max-h-64 overflow-y-auto'>
                {editableGroupOptions(detail.groups || [], allowedGroups).map(
                  (g) => (
                    <DropdownMenuCheckboxItem
                      key={g.id}
                      checked={groupIds.includes(g.id)}
                      disabled={!g.available && !groupIds.includes(g.id)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(checked) => {
                        if (checked && !g.available) return
                        setGroupsChanged(true)
                        setGroupIds(
                          checked
                            ? [...groupIds, g.id]
                            : groupIds.filter((id) => id !== g.id)
                        )
                      }}
                    >
                      {g.name}
                      {!g.available && ' · ' + t('state.unavailable')}
                    </DropdownMenuCheckboxItem>
                  )
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className='grid grid-cols-2 gap-4'>
            <label className='grid gap-2 text-sm'>
              {t('details.concurrencyLimit')}
              <Input
                readOnly
                disabled
                value={detail.telemetry?.max_concurrency ?? ''}
              />
            </label>
            <label className='grid gap-2 text-sm'>
              {t('details.weight')}
              <Input
                readOnly
                disabled
                value={detail.telemetry?.priority ?? ''}
              />
            </label>
          </div>
          <p className='text-xs text-muted-foreground'>
            {t('details.platformManaged')}
          </p>
        </section>
        <section className='space-y-4 rounded-xl border bg-muted/10 p-4'>
          <h3 className='text-sm font-semibold'>{t('details.proxyConfig')}</h3>
          <p className='text-sm break-all text-muted-foreground'>
            {t('details.currentProxy', {
              proxy: detail.proxy?.endpoint || '—',
            })}
          </p>
          <fieldset className='space-y-2'>
            <legend className='mb-2 text-sm font-medium'>
              {t('details.proxySource')}
            </legend>
            <div className='flex flex-wrap gap-4'>
              {['auto', 'manual'].map((key) => (
                <label className='flex items-center gap-2 text-sm' key={key}>
                  <input
                    type='radio'
                    name={'proxy-source-' + detail.id}
                    value={key}
                    checked={
                      key === 'manual' ? source !== 'auto' : source === 'auto'
                    }
                    onClick={() => setProxyChanged(true)}
                    onChange={() => {
                      setSource(
                        key === 'manual'
                          ? proxyId
                            ? 'existing'
                            : 'new'
                          : 'auto'
                      )
                      setProxyChanged(true)
                    }}
                  />
                  {t('details.proxySourceLabel.' + key)}
                </label>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('details.keepProxy')}
            </p>
          </fieldset>
          {source !== 'auto' && (
            <AccountProxyInput
              endpoint={endpoint}
              proxyId={proxyId}
              proxies={options}
              onChange={(value) => {
                setEndpoint(value.proxy_endpoint)
                setProxyId(value.proxy_id)
                setSource(value.proxy_id ? 'existing' : 'new')
                setProxyChanged(true)
              }}
            />
          )}
          <label className='grid gap-2 text-sm'>
            {t('details.proxyRegion')}
            <select
              className='h-10 rounded-lg border bg-background px-3'
              disabled={source === 'new'}
              value={region}
              onChange={(e) => {
                setRegion(e.target.value)
                setProxyChanged(true)
                if (source === 'existing') setProxyId('')
              }}
            >
              <option value=''>{t('details.allRegions')}</option>
              {regions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <p className='text-xs text-muted-foreground'>
            {t('details.regionHelp')}
          </p>
          {proxyChanged && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => {
                setProxyChanged(false)
                setSource('auto')
                setProxyId(String(detail.config.proxy_id || ''))
                setEndpoint('')
                setRegion('')
              }}
            >
              {t('details.keepCurrentProxy')}
            </Button>
          )}
        </section>
      </fieldset>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          type='button'
          variant='outline'
          disabled={busy}
          onClick={onClose}
        >
          {t('cancel')}
        </Button>
        <Button type='submit' disabled={busy}>
          {t('wb.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

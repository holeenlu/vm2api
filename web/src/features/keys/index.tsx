import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { ApiKeyItem } from '@/types/panel-keys'
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { FormField as Label } from '@/components/form-field'
import { PageHeader } from '@/components/page-header'
import { SearchSelect } from '@/components/search-select'
import { meQueryOptions } from '@/features/auth/queries'
import { groupsQueryOptions } from '@/features/groups/queries'
import { usersQueryOptions } from '@/features/users/queries'
import { keyStatusTone, keyQuotaLabel } from './key-format'
import { KeyRevealDialog } from './key-reveal-dialog'
import { KeyStatsDialog } from './key-stats-dialog'
import { apiKeysQueryOptions } from './queries'
import { UseKeyDialog } from './use-key-dialog'

const EMPTY = {
  user_id: '',
  name: '',
  group_id: '',
  max_concurrency: 0,
  quota_usd: 0,
  quota_requests: 0,
  rpm: 0,
  rate_limit_5h: 0,
  rate_limit_1d: 0,
  rate_limit_7d: 0,
  expires_at: '',
  ip_whitelist: '',
  ip_blacklist: '',
  custom_key: '',
}
export function KeysPage() {
  const { t } = useTranslation('keys')

  const keyScope =
    new URLSearchParams(window.location.hash.split('?')[1] || '').get(
      'scope'
    ) === 'mine'
      ? 'mine'
      : 'all'
  const q = useQuery(apiKeysQueryOptions(keyScope))
  const groups = useQuery(groupsQueryOptions())
  const me = useQuery(meQueryOptions())
  const qc = useQueryClient()
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: me.data?.role === 'super_admin' || me.data?.role === 'admin',
  })
  const [userFilter, setUserFilter] = useState(
    () =>
      new URLSearchParams(window.location.hash.split('?')[1] || '').get(
        'userId'
      ) || ''
  )
  const [groupFilter, setGroupFilter] = useState(''),
    [search, setSearch] = useState('')
  const visible = (q.data?.keys || []).filter(
    (k) =>
      (!userFilter || k.user_id === userFilter) &&
      (!groupFilter || String(k.group_id) === groupFilter) &&
      (k.name || '').toLowerCase().includes(search.toLowerCase())
  )
  const [edit, setEdit] = useState<ApiKeyItem | null | undefined>()
  const [form, setForm] = useState(EMPTY)
  const nameInput = useRef<HTMLInputElement>(null)
  const ownerGroups = useQuery({
    queryKey: ['panel', 'groups', 'available_to', form.user_id],
    queryFn: () =>
      api<{ items: { id: number; name: string; rate_multiplier: number }[] }>(
        `/api/panel/groups?available_to=${encodeURIComponent(form.user_id)}`
      ),
    enabled:
      edit !== undefined &&
      (me.data?.role === 'super_admin' || me.data?.role === 'admin') &&
      !!form.user_id,
  })
  const availableGroups =
    (me.data?.role === 'super_admin' || me.data?.role === 'admin') &&
    form.user_id
      ? ownerGroups.data?.items || []
      : groups.data?.items || []
  const [reveal, setReveal] = useState<{
    titleKey: 'keys:copyKey' | 'keys:title'
    name: string
    key: string
  } | null>(null)
  const [useKey, setUseKey] = useState<{
    id: string
    name: string
    key: string
  } | null>(null)
  const [secretBusy, setSecretBusy] = useState('')
  async function readSecret(item: ApiKeyItem, action: 'copy' | 'use') {
    setSecretBusy(item.id)
    try {
      const data = await api<{ key: string }>(
        `/api/panel/api-keys/${item.id}/reveal`,
        { method: 'POST' }
      )
      if (action === 'use')
        setUseKey({ id: item.id, name: item.name || '', key: data.key })
      else if (await copyText(data.key)) toast.success(t('keys:keyCopied'))
      else
        setReveal({
          titleKey: 'keys:copyKey',
          name: item.name || '',
          key: data.key,
        })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSecretBusy('')
    }
  }
  const [stats, setStats] = useState<ApiKeyItem | null>(null)
  const mutation = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string
      method: string
      body?: unknown
    }) =>
      api<{ item?: ApiKeyItem; key?: string }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async (data) => {
      setEdit(undefined)
      const key = data.item?.key || data.key
      if (key && !key.includes('…'))
        setReveal({ titleKey: 'keys:title', name: data.item?.name || '', key })
      await qc.invalidateQueries({ queryKey: ['panel', 'api-keys'] })
      toast.success(t('keys:success'))
    },
    onError: (e: Error) => toast.error(e.message),
  })
  function open(k: ApiKeyItem | null) {
    setEdit(k)
    setForm({
      ...EMPTY,
      ...k,
      name: k?.name || '',
      user_id: k?.user_id || userFilter || '',
      group_id: k ? (k.group_id ? String(k.group_id) : '__platform__') : '',
      max_concurrency: k?.max_concurrency || 0,
      quota_usd: k?.quota_usd || 0,
      quota_requests: k?.quota_requests || 0,
      rpm: k?.rpm || 0,
      rate_limit_5h: k?.rate_limit_5h || 0,
      rate_limit_1d: k?.rate_limit_1d || 0,
      rate_limit_7d: k?.rate_limit_7d || 0,
      expires_at: k?.expires_at?.slice(0, 16) || '',
      ip_whitelist: (k?.ip_whitelist || []).join(','),
      ip_blacklist: (k?.ip_blacklist || []).join(','),
    })
  }
  const [action, setAction] = useState<{
    key: ApiKeyItem
    kind: 'rotate' | 'delete' | 'reset'
  } | null>(null)
  const numeric = {
    max_concurrency: t('keys:concurrencyLimit'),
    quota_usd: t('keys:amountLimit'),
    quota_requests: t('keys:requestLimit'),
    rpm: t('keys:rpmLimit'),
    rate_limit_5h: t('keys:fiveHourLimit'),
    rate_limit_1d: t('keys:dailyLimit'),
    rate_limit_7d: t('keys:weeklyLimit'),
  } as const
  return (
    <PageHeader
      title={t('keys:title')}
      description={t('keys:description')}
      extra={<Button onClick={() => open(null)}>{t('keys:create')}</Button>}
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      <div className='mb-4 flex flex-wrap gap-2'>
        <Input
          className='max-w-xs'
          placeholder={t('keys:search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {me.data?.role === 'super_admin' || me.data?.role === 'admin' ? (
          <SearchSelect
            className='min-w-52'
            label={t('keys:filterUser')}
            value={userFilter}
            options={(users.data?.items || []).map((u) => ({
              id: u.id,
              name: u.username,
            }))}
            searchPlaceholder={t('keys:searchUser')}
            allLabel={t('keys:allUsers')}
            onChange={(value) => {
              setUserFilter(value || '')
            }}
          />
        ) : null}
        <SearchSelect
          className='min-w-52'
          label={t('keys:filterGroup')}
          value={groupFilter}
          options={(groups.data?.items || []).map((g) => ({
            id: String(g.id),
            name: g.name,
          }))}
          searchPlaceholder={t('keys:searchGroup')}
          allLabel={t('keys:allGroups')}
          onChange={(value) => {
            setGroupFilter(value || '')
          }}
        />
      </div>
      <div className='overflow-auto rounded border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                t('keys:name'),
                t('keys:key'),
                t('keys:group'),
                t('keys:status'),
                t('keys:usageLimits'),
                t('keys:actions'),
              ].map((v) => (
                <th key={v} className='p-3 text-left'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((k) => (
              <tr key={k.id} className='border-b'>
                <td className='p-3'>
                  {k.name}
                  {me.data?.role === 'super_admin' ||
                  me.data?.role === 'admin' ? (
                    <p className='text-xs text-muted-foreground'>
                      {users.data?.items?.find((u) => u.id === k.user_id)
                        ?.username || t('keys:platformService')}
                    </p>
                  ) : null}
                </td>
                <td className='p-3'>
                  <div className='flex items-center gap-1'>
                    <code className='text-xs'>{k.key}</code>
                    <Button
                      aria-label={t('keys:copyNamedKey', {
                        name: k.name || t('keys:key'),
                      })}
                      size='icon'
                      variant='ghost'
                      disabled={secretBusy === k.id}
                      onClick={() => void readSecret(k, 'copy')}
                    >
                      <Copy className='size-4' />
                    </Button>
                  </div>
                  {k.secret_status === 'decrypt_failed' && (
                    <p className='text-xs text-destructive'>
                      {t('keys:recoverDecryption')}
                    </p>
                  )}
                  {k.secret_status === 'hash_only' && (
                    <p className='text-xs text-muted-foreground'>
                      {t('keys:legacyHashedKey')}
                    </p>
                  )}
                </td>
                <td className='p-3'>
                  {k.group_name ||
                    groups.data?.items.find((g) => g.id === k.group_id)?.name ||
                    t('keys:platformService')}
                </td>
                <td className='p-3'>
                  {keyStatusTone(k).text}
                  <p className='text-xs text-muted-foreground'>
                    {k.expires_at
                      ? new Date(k.expires_at).toLocaleDateString(i18n.language)
                      : t('keys:noExpiry')}
                  </p>
                </td>
                <td className='p-3'>{keyQuotaLabel(k)}</td>
                <td className='space-x-2 p-3'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={secretBusy === k.id}
                    onClick={() => void readSecret(k, 'use')}
                  >
                    {t('keys:use')}
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => open(k)}>
                    {t('keys:edit')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setStats(k)}
                  >
                    {t('keys:usage')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        path: '/api/panel/api-keys/' + k.id + '/reveal',
                        method: 'POST',
                      })
                    }
                  >
                    {t('keys:view')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        path: '/api/panel/api-keys/' + k.id,
                        method: 'PATCH',
                        body: {
                          status: k.status === 'active' ? 'disabled' : 'active',
                        },
                      })
                    }
                  >
                    {k.status === 'active'
                      ? t('keys:disabled')
                      : t('keys:enabled')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'rotate' })}
                  >
                    {t('keys:rotate')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'reset' })}
                  >
                    {t('keys:resetLimits')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'delete' })}
                  >
                    {t('keys:revoke')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={edit !== undefined}
        onOpenChange={(v) => !v && setEdit(undefined)}
      >
        <DialogContent
          className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            nameInput.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {edit ? t('keys:editKey') : t('keys:create')}
            </DialogTitle>
          </DialogHeader>
          <form
            className='space-y-5'
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate({
                path: '/api/panel/api-keys' + (edit ? '/' + edit.id : ''),
                method: edit ? 'PATCH' : 'POST',
                body: {
                  ...form,
                  group_id:
                    form.group_id === '__platform__'
                      ? null
                      : Number(form.group_id),
                  expires_at: form.expires_at
                    ? new Date(form.expires_at + 'Z').toISOString()
                    : null,
                  ip_whitelist: form.ip_whitelist
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                  ip_blacklist: form.ip_blacklist
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                },
              })
            }}
          >
            {(me.data?.role === 'super_admin' || me.data?.role === 'admin') &&
            !edit ? (
              <Label>
                {t('keys:owner')}
                <SearchSelect
                  label={t('keys:owner')}
                  value={form.user_id}
                  options={(users.data?.items || []).map((u) => ({
                    id: u.id,
                    name: u.username,
                  }))}
                  allLabel={t('keys:currentAdmin')}
                  searchPlaceholder={t('keys:searchOwner')}
                  onChange={(id) =>
                    setForm({ ...form, user_id: id || '', group_id: '' })
                  }
                />
              </Label>
            ) : null}
            <Label>
              {t('keys:name')}
              <Input
                ref={nameInput}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Label>
            <Label>
              {t('keys:serviceGroup')}
              <SearchSelect
                label={t('keys:serviceGroup')}
                value={form.group_id}
                options={[
                  ...(me.data?.role === 'super_admin' &&
                  (!form.user_id ||
                    users.data?.items?.find((u) => u.id === form.user_id)
                      ?.role === 'super_admin')
                    ? [
                        {
                          id: '__platform__',
                          name: t('keys:adminKey'),
                        },
                      ]
                    : []),
                  ...availableGroups.map((g) => ({
                    id: String(g.id),
                    name: `${g.name} · ${g.rate_multiplier ?? '—'}×`,
                  })),
                ]}
                searchPlaceholder={t('keys:searchServiceGroup')}
                onChange={(id) => setForm({ ...form, group_id: id || '' })}
              />
            </Label>
            {ownerGroups.error && (
              <p role='alert' className='text-sm text-destructive'>
                {ownerGroups.error.message}
              </p>
            )}
            {form.group_id === '__platform__' && (
              <p className='rounded-lg border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground'>
                {t('keys:adminKeyHelp')}
              </p>
            )}
            {!edit && (
              <Label>
                {t('keys:customKey')}
                <Input
                  type='password'
                  autoComplete='off'
                  placeholder={t('keys:customKeyPlaceholder')}
                  value={form.custom_key}
                  onChange={(e) =>
                    setForm({ ...form, custom_key: e.target.value })
                  }
                />
              </Label>
            )}
            <h3 className='border-t pt-4 text-sm font-semibold'>
              {t('keys:limits')}
            </h3>
            <div className='grid gap-4 sm:grid-cols-2'>
              {Object.entries(numeric).map(([field, label]) => (
                <Label key={field}>
                  {label}
                  <Input
                    type='number'
                    min='0'
                    step={
                      field === 'max_concurrency' ||
                      field === 'rpm' ||
                      field === 'quota_requests'
                        ? '1'
                        : '0.000001'
                    }
                    value={form[field as keyof typeof numeric]}
                    onChange={(e) =>
                      setForm({ ...form, [field]: Number(e.target.value) })
                    }
                  />
                </Label>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('keys:limitsHelp')}
            </p>
            <h3 className='border-t pt-4 text-sm font-semibold'>
              {t('keys:accessLimits')}
            </h3>
            <div className='flex flex-wrap gap-2'>
              {[7, 30, 90, 180].map((days) => (
                <Button
                  key={days}
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={() =>
                    setForm({
                      ...form,
                      expires_at: new Date(Date.now() + days * 86400000)
                        .toISOString()
                        .slice(0, 16),
                    })
                  }
                >
                  {t('keys:expiryDays', { count: days })}
                </Button>
              ))}
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => setForm({ ...form, expires_at: '' })}
              >
                {t('keys:noExpiry')}
              </Button>
            </div>
            <Label>
              {t('keys:expiryUtc')}
              <Input
                type='datetime-local'
                value={form.expires_at}
                onChange={(e) =>
                  setForm({ ...form, expires_at: e.target.value })
                }
              />
            </Label>
            <Label>
              {t('keys:ipAllowlist')}
              <Input
                value={form.ip_whitelist}
                onChange={(e) =>
                  setForm({ ...form, ip_whitelist: e.target.value })
                }
              />
            </Label>
            <Label>
              {t('keys:ipBlocklist')}
              <Input
                value={form.ip_blacklist}
                onChange={(e) =>
                  setForm({ ...form, ip_blacklist: e.target.value })
                }
              />
            </Label>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setEdit(undefined)}
              >
                {t('keys:cancel')}
              </Button>
              <Button disabled={mutation.isPending || !form.group_id}>
                {t('keys:save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!action}
        onOpenChange={(v) => !v && setAction(null)}
        title={
          action?.kind === 'rotate'
            ? t('keys:rotateKey')
            : action?.kind === 'delete'
              ? t('keys:revokeKey')
              : t('keys:resetKeyLimits')
        }
        desc={
          action?.kind === 'reset' ? t('keys:resetHelp') : t('keys:revokeHelp')
        }
        confirmText={t('keys:confirm')}
        handleConfirm={() => {
          if (!action) return
          mutation.mutate({
            path:
              '/api/panel/api-keys/' +
              action.key.id +
              (action.kind === 'rotate'
                ? '/rotate'
                : action.kind === 'reset'
                  ? '/reset-quota'
                  : ''),
            method: action.kind === 'delete' ? 'DELETE' : 'POST',
          })
          setAction(null)
        }}
      />
      {useKey && (
        <UseKeyDialog value={useKey} onClose={() => setUseKey(null)} />
      )}
      <KeyRevealDialog value={reveal} onClose={() => setReveal(null)} />
      <KeyStatsDialog
        vms={[]}
        item={stats}
        onOpenChange={(v) => !v && setStats(null)}
      />
    </PageHeader>
  )
}

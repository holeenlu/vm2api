import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type { PanelUser } from '@/types/panel-users'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { idempotencyKey } from '@/lib/idempotency-key'
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
import { meQueryOptions } from '@/features/auth/queries'
import { groupsQueryOptions } from '@/features/groups/queries'
import { GroupGrants, type GroupGrant } from './group-grants'
import { usersQueryOptions } from './queries'

const ROLES = {
  get super_admin() {
    return t('common:superAdmin')
  },
  get admin() {
    return t('common:administrator')
  },
  get user() {
    return t('users:user')
  },
}
const EMPTY = {
  username: '',
  password: '',
  role: 'user' as 'user' | 'admin' | 'super_admin',
  enabled: true,
  concurrency: 5,
  rpm_limit: 0,
  restrict_public_groups: true,
}
export function UsersPage() {
  const { t } = useTranslation('users')

  const q = useQuery(usersQueryOptions())
  const me = useQuery(meQueryOptions())
  const sa = me.data?.role === 'super_admin'
  const groups = useQuery({ ...groupsQueryOptions(), enabled: sa })
  const qc = useQueryClient()
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0),
    [remove, setRemove] = useState<PanelUser | null>(null)
  const rows = (q.data?.items || []).filter((u) =>
    u.username.toLowerCase().includes(search.toLowerCase())
  )
  const [edit, setEdit] = useState<PanelUser | null | undefined>()
  const [form, setForm] = useState(EMPTY)
  const [formGrants, setFormGrants] = useState<GroupGrant[]>([])
  const [wallet, setWallet] = useState<PanelUser | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [operation, setOperation] = useState('add')
  const [idem, setIdem] = useState('')
  const history = useQuery({
    queryKey: ['panel', 'wallet', wallet?.id],
    queryFn: () =>
      api<{
        items: {
          id: string
          kind: string
          amount: number
          reason: string
          created_at: string
        }[]
        available: number
      }>('/api/panel/users/' + wallet?.id + '/balance-history'),
    enabled: !!wallet,
  })
  const change = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string
      method: string
      body?: unknown
    }) =>
      api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success(t('users:saved'))
      setEdit(undefined)
      setAmount('')
      setReason('')
      setIdem(idempotencyKey())
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const open = (u: PanelUser | null) => {
    setEdit(u)
    setForm({ ...EMPTY, ...u, password: '' })
    const explicit = u?.groups || []
    const publicGrants =
      u?.restrict_public_groups === false
        ? (groups.data?.items || [])
            .filter(
              (g) =>
                !g.is_exclusive && !explicit.some((v) => v.group_id === g.id)
            )
            .map((g) => ({ group_id: g.id, rate_multiplier: null }))
        : []
    setFormGrants([...explicit, ...publicGrants])
  }
  return (
    <PageHeader
      title={t('users:title')}
      description={t('users:description')}
      extra={
        <Button disabled={sa && !groups.isSuccess} onClick={() => open(null)}>
          {t('users:create')}
        </Button>
      }
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {sa && groups.error && (
        <p role='alert' className='mb-4 text-destructive'>
          {t('users:groupsFailed', { message: groups.error.message })}
        </p>
      )}
      <Input
        className='mb-4 max-w-xs'
        placeholder={t('users:search')}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setPage(0)
        }}
      />
      <div className='overflow-auto rounded-md border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                t('users:user'),
                t('users:role'),
                t('users:status'),
                t('users:balanceUsd'),
                t('users:concurrency'),
                t('users:actions'),
              ].map((v) => (
                <th key={v} className='p-3 text-left'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 50, (page + 1) * 50).map((u) => (
              <tr key={u.id} className='border-b'>
                <td className='p-3'>{u.username}</td>
                <td className='p-3'>{ROLES[u.role]}</td>
                <td className='p-3'>
                  {u.enabled ? t('users:enabled') : t('users:disabled')}
                </td>
                <td className='p-3 tabular-nums'>
                  {Number(u.balance || 0).toFixed(6)}
                </td>
                <td className='p-3'>{u.concurrency || t('users:unlimited')}</td>
                <td className='space-x-2 p-3'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={sa && !groups.isSuccess}
                    onClick={() => open(u)}
                  >
                    {t('users:edit')}
                  </Button>
                  {sa && (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => {
                        setWallet(u)
                        setAmount('')
                        setReason('')
                        setOperation('add')
                        setIdem(idempotencyKey())
                      }}
                    >
                      {t('users:balanceHistory')}
                    </Button>
                  )}
                  {sa && (
                    <Button asChild size='sm' variant='ghost'>
                      <a href={'#/keys?userId=' + encodeURIComponent(u.id)}>
                        {t('users:apiKeys')}
                      </a>
                    </Button>
                  )}
                  <Button asChild size='sm' variant='ghost'>
                    <a href={'#/logs?userId=' + encodeURIComponent(u.id)}>
                      {t('users:usage')}
                    </a>
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setRemove(u)}
                  >
                    {t('users:delete')}
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
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              {edit ? t('users:editUser') : t('users:create')}
            </DialogTitle>
          </DialogHeader>
          <form
            className='space-y-5'
            onSubmit={(e) => {
              e.preventDefault()
              change.mutate({
                path: '/api/panel/users' + (edit ? '/' + edit.id : ''),
                method: edit ? 'PATCH' : 'POST',
                body: sa
                  ? {
                      ...form,
                      groups: formGrants,
                      restrict_public_groups: true,
                    }
                  : edit
                    ? {
                        ...(form.password ? { password: form.password } : {}),
                        enabled: form.enabled,
                      }
                    : {
                        username: form.username,
                        password: form.password,
                        role: 'user',
                        enabled: form.enabled,
                      },
              })
            }}
          >
            <Label>
              {t('users:username')}
              <Input
                value={form.username}
                disabled={!!edit}
                required
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Label>
            <Label>
              {edit ? t('users:optionalPassword') : t('users:password')}
              <Input
                type='password'
                autoComplete='new-password'
                value={form.password}
                minLength={8}
                required={!edit}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Label>
            <Label>
              {t('users:role')}
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as typeof form.role })
                }
              >
                {Object.entries(ROLES)
                  .filter(([id]) => sa || id === 'user')
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </Label>
            {sa && (
              <div className='grid gap-4 sm:grid-cols-2'>
                <div className='min-w-0 space-y-2'>
                  <Label htmlFor='user-concurrency'>
                    {t('users:concurrencyLimit')}
                    <Input
                      id='user-concurrency'
                      aria-describedby='user-concurrency-hint'
                      type='number'
                      min='0'
                      value={form.concurrency}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          concurrency: Number(e.target.value),
                        })
                      }
                    />
                  </Label>
                  <p
                    id='user-concurrency-hint'
                    className='text-xs leading-5 text-muted-foreground'
                  >
                    {t('users:concurrencyHelp')}
                  </p>
                </div>
                <div className='min-w-0 space-y-2'>
                  <Label htmlFor='user-rpm'>
                    {t('users:rpmLimit')}
                    <Input
                      id='user-rpm'
                      aria-describedby='user-rpm-hint'
                      type='number'
                      min='0'
                      value={form.rpm_limit}
                      onChange={(e) =>
                        setForm({ ...form, rpm_limit: Number(e.target.value) })
                      }
                    />
                  </Label>
                  <p
                    id='user-rpm-hint'
                    className='text-xs leading-5 text-muted-foreground'
                  >
                    {t('users:rpmHelp')}
                  </p>
                </div>
              </div>
            )}
            <label className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              {t('users:enabled')}
            </label>
            {sa && (
              <GroupGrants
                groups={groups.data?.items || []}
                value={formGrants}
                onChange={setFormGrants}
              />
            )}
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setEdit(undefined)}
              >
                {t('users:cancel')}
              </Button>
              <Button
                disabled={
                  change.isPending ||
                  (sa && (groups.isLoading || !!groups.error))
                }
              >
                {t('users:save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!wallet} onOpenChange={(v) => !v && setWallet(null)}>
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              {t('users:walletTitle', { name: wallet?.username })}
            </DialogTitle>
          </DialogHeader>
          <p>
            {t('users:availableBalance', {
              amount: history.data?.available?.toFixed(6) ?? '—',
            })}
          </p>
          <form
            className='space-y-5'
            onSubmit={(e) => {
              e.preventDefault()
              if (wallet)
                change.mutate({
                  path: '/api/panel/users/' + wallet.id + '/balance',
                  method: 'POST',
                  body: {
                    amount: Number(amount),
                    operation,
                    reason,
                    idempotency_key: idem,
                  },
                })
            }}
          >
            <select
              aria-label={t('users:fundAction')}
              className='h-9 w-full rounded border bg-background px-2'
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              <option value='add'>{t('users:credit')}</option>
              <option value='subtract'>{t('users:debit')}</option>
            </select>
            <Label>
              {t('users:amountUsd')}
              <Input
                type='number'
                min='0.000001'
                step='0.000001'
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Label>
            <Label>
              {t('users:reason')}
              <Input
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Label>
            <Button disabled={change.isPending}>
              {t(
                operation === 'add'
                  ? 'users:confirmCredit'
                  : 'users:confirmDebit'
              )}
            </Button>
          </form>
          <div className='space-y-2'>
            {history.data?.items.map((row) => (
              <div key={row.id} className='border-t pt-2 text-sm'>
                <b>{row.amount.toFixed(6)} USD</b> · {row.reason}
                <p className='text-xs text-muted-foreground'>
                  {row.created_at}
                </p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <div className='mt-4 flex items-center gap-3'>
        <Button
          variant='outline'
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          {t('users:previous')}
        </Button>
        <span className='text-sm'>
          {t('users:pagination', {
            page: page + 1,
            pages: Math.max(1, Math.ceil(rows.length / 50)),
            count: rows.length,
          })}
        </span>
        <Button
          variant='outline'
          disabled={(page + 1) * 50 >= rows.length}
          onClick={() => setPage(page + 1)}
        >
          {t('users:next')}
        </Button>
      </div>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title={t('users:deleteUser')}
        desc={t('users:deleteHelp')}
        confirmText={t('users:delete')}
        destructive
        handleConfirm={() => {
          if (!remove) return
          void api('/api/panel/users/' + remove.id, { method: 'DELETE' })
            .then(() => {
              setRemove(null)
              void qc.invalidateQueries({ queryKey: ['panel'] })
            })
            .catch((e: Error) => toast.error(e.message))
        }}
      />
    </PageHeader>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PanelUser } from '@/types/panel-users'
import { toast } from 'sonner'
import { api } from '@/lib/api'
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
import { groupsQueryOptions } from '@/features/groups/queries'
import { GroupGrants, type GroupGrant } from './group-grants'
import { usersQueryOptions } from './queries'

const ROLES = { admin: '站长', super: '运维', user: '用户' }
const EMPTY = {
  username: '',
  password: '',
  role: 'user' as 'user' | 'admin' | 'super',
  enabled: true,
  concurrency: 5,
  rpm_limit: 0,
  restrict_public_groups: true,
}
export function UsersPage() {
  const q = useQuery(usersQueryOptions())
  const groups = useQuery(groupsQueryOptions())
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
      toast.success('已保存')
      setEdit(undefined)
      setAmount('')
      setReason('')
      setIdem(crypto.randomUUID())
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
      title='用户管理'
      description='统一管理用户身份、分组授权、并发和余额。'
      extra={
        <Button disabled={!groups.isSuccess} onClick={() => open(null)}>
          新建用户
        </Button>
      }
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {groups.error && (
        <p role='alert' className='mb-4 text-destructive'>
          分组加载失败，暂时无法编辑用户授权：{groups.error.message}
        </p>
      )}
      <Input
        className='mb-4 max-w-xs'
        placeholder='搜索用户'
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
              {['用户', '角色', '状态', '余额 USD', '并发', '操作'].map((v) => (
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
                <td className='p-3'>{u.enabled ? '启用' : '停用'}</td>
                <td className='p-3 tabular-nums'>
                  {Number(u.balance || 0).toFixed(6)}
                </td>
                <td className='p-3'>{u.concurrency || '不限'}</td>
                <td className='space-x-2 p-3'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!groups.isSuccess}
                    onClick={() => open(u)}
                  >
                    编辑
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => {
                      setWallet(u)
                      setAmount('')
                      setReason('')
                      setOperation('add')
                      setIdem(crypto.randomUUID())
                    }}
                  >
                    余额与流水
                  </Button>
                  <Button asChild size='sm' variant='ghost'>
                    <a href={'#/keys?userId=' + encodeURIComponent(u.id)}>
                      Key
                    </a>
                  </Button>
                  <Button asChild size='sm' variant='ghost'>
                    <a href={'#/logs?userId=' + encodeURIComponent(u.id)}>
                      用量
                    </a>
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setRemove(u)}
                  >
                    删除
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
            <DialogTitle>{edit ? '编辑用户' : '新建用户'}</DialogTitle>
          </DialogHeader>
          <form
            className='space-y-5'
            onSubmit={(e) => {
              e.preventDefault()
              change.mutate({
                path: '/api/panel/users' + (edit ? '/' + edit.id : ''),
                method: edit ? 'PATCH' : 'POST',
                body: {
                  ...form,
                  groups: formGrants,
                  restrict_public_groups: true,
                },
              })
            }}
          >
            <Label>
              用户名
              <Input
                value={form.username}
                disabled={!!edit}
                required
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </Label>
            <Label>
              {edit ? '新密码（留空不修改）' : '密码'}
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
              角色
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as typeof form.role })
                }
              >
                {Object.entries(ROLES).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Label>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='min-w-0 space-y-2'>
                <Label htmlFor='user-concurrency'>
                  并发上限
                  <Input
                    id='user-concurrency'
                    aria-describedby='user-concurrency-hint'
                    type='number'
                    min='0'
                    value={form.concurrency}
                    onChange={(e) =>
                      setForm({ ...form, concurrency: Number(e.target.value) })
                    }
                  />
                </Label>
                <p
                  id='user-concurrency-hint'
                  className='text-xs leading-5 text-muted-foreground'
                >
                  该用户的最大并发请求数，0 = 不限制
                </p>
              </div>
              <div className='min-w-0 space-y-2'>
                <Label htmlFor='user-rpm'>
                  RPM 上限
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
                  该用户全部 API Key 共享的每分钟最大请求数，0 =
                  不限制；同时受当前分组 RPM 约束
                </p>
              </div>
            </div>
            <label className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={form.enabled}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />
              启用
            </label>
            <GroupGrants
              groups={groups.data?.items || []}
              value={formGrants}
              onChange={setFormGrants}
            />
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setEdit(undefined)}
              >
                取消
              </Button>
              <Button
                disabled={
                  change.isPending || groups.isLoading || !!groups.error
                }
              >
                保存用户
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!wallet} onOpenChange={(v) => !v && setWallet(null)}>
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{wallet?.username} · 余额与流水</DialogTitle>
          </DialogHeader>
          <p>可用余额：{history.data?.available?.toFixed(6) ?? '—'} USD</p>
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
              aria-label='资金操作'
              className='h-9 w-full rounded border bg-background px-2'
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              <option value='add'>充值</option>
              <option value='subtract'>扣款</option>
            </select>
            <Label>
              金额 USD
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
              操作原因
              <Input
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Label>
            <Button disabled={change.isPending}>
              确认{operation === 'add' ? '充值' : '扣款'}
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
          上一页
        </Button>
        <span className='text-sm'>
          {page + 1} / {Math.max(1, Math.ceil(rows.length / 50))} ·{' '}
          {rows.length} 个用户
        </span>
        <Button
          variant='outline'
          disabled={(page + 1) * 50 >= rows.length}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title='删除用户'
        desc='用户会话与 Key 将失效，历史资金和用量记录保留。'
        confirmText='删除'
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

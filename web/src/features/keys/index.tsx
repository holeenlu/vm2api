import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiKeyItem } from '@/types/panel-keys'
import { Copy } from 'lucide-react'
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
  const q = useQuery(apiKeysQueryOptions())
  const groups = useQuery(groupsQueryOptions())
  const me = useQuery(meQueryOptions())
  const qc = useQueryClient()
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: me.data?.role === 'admin',
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
    enabled: edit !== undefined && me.data?.role === 'admin' && !!form.user_id,
  })
  const availableGroups =
    me.data?.role === 'admin' && form.user_id
      ? ownerGroups.data?.items || []
      : groups.data?.items || []
  const [reveal, setReveal] = useState<{
    title: string
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
      else if (await copyText(data.key)) toast.success('已复制密钥')
      else
        setReveal({ title: '复制密钥', name: item.name || '', key: data.key })
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
        setReveal({ title: 'API Key', name: data.item?.name || '', key })
      await qc.invalidateQueries({ queryKey: ['panel', 'api-keys'] })
      toast.success('操作成功')
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
    max_concurrency: 'Key 并发上限',
    quota_usd: '金额上限 USD',
    quota_requests: '请求次数上限',
    rpm: 'Key RPM（0 = 不限制）',
    rate_limit_5h: '5 小时消费上限 USD',
    rate_limit_1d: '24 小时消费上限 USD',
    rate_limit_7d: '7 天消费上限 USD',
  } as const
  return (
    <PageHeader
      title='API Key'
      description='用户全部 Key 共享账户资金和用户 RPM；分组 RPM 按用户共享，Key RPM 仅进一步收紧。'
      extra={<Button onClick={() => open(null)}>创建 API Key</Button>}
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      <div className='mb-4 flex flex-wrap gap-2'>
        <Input
          className='max-w-xs'
          placeholder='搜索 Key 名称'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {me.data?.role === 'admin' ? (
          <SearchSelect
            className='min-w-52'
            label='筛选用户'
            value={userFilter}
            options={(users.data?.items || []).map((u) => ({
              id: u.id,
              name: u.username,
            }))}
            searchPlaceholder='搜索用户…'
            allLabel='全部用户'
            onChange={(value) => {
              setUserFilter(value || '')
            }}
          />
        ) : null}
        <SearchSelect
          className='min-w-52'
          label='筛选分组'
          value={groupFilter}
          options={(groups.data?.items || []).map((g) => ({
            id: String(g.id),
            name: g.name,
          }))}
          searchPlaceholder='搜索分组…'
          allLabel='全部分组'
          onChange={(value) => {
            setGroupFilter(value || '')
          }}
        />
      </div>
      <div className='overflow-auto rounded border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {['名称', '密钥', '分组', '状态', '用量 / 自限额', '操作'].map(
                (v) => (
                  <th key={v} className='p-3 text-left'>
                    {v}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((k) => (
              <tr key={k.id} className='border-b'>
                <td className='p-3'>
                  {k.name}
                  {me.data?.role === 'admin' ? (
                    <p className='text-xs text-muted-foreground'>
                      {users.data?.items?.find((u) => u.id === k.user_id)
                        ?.username || '平台服务'}
                    </p>
                  ) : null}
                </td>
                <td className='p-3'>
                  <div className='flex items-center gap-1'>
                    <code className='text-xs'>{k.key}</code>
                    <Button
                      aria-label={`复制 ${k.name || '密钥'}`}
                      size='icon'
                      variant='ghost'
                      disabled={secretBusy === k.id}
                      onClick={() => void readSecret(k, 'copy')}
                    >
                      <Copy className='size-4' />
                    </Button>
                  </div>
                  {k.secret_status === 'decrypt_failed' && (
                    <p className='text-xs text-destructive'>解密密钥需恢复</p>
                  )}
                  {k.secret_status === 'hash_only' && (
                    <p className='text-xs text-muted-foreground'>
                      历史哈希密钥
                    </p>
                  )}
                </td>
                <td className='p-3'>
                  {k.group_name ||
                    groups.data?.items.find((g) => g.id === k.group_id)?.name ||
                    '平台服务'}
                </td>
                <td className='p-3'>
                  {keyStatusTone(k).text}
                  <p className='text-xs text-muted-foreground'>
                    {k.expires_at
                      ? new Date(k.expires_at).toLocaleDateString()
                      : '不过期'}
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
                    使用
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => open(k)}>
                    编辑
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => setStats(k)}
                  >
                    用量
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
                    查看
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
                    {k.status === 'active' ? '停用' : '启用'}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'rotate' })}
                  >
                    轮换
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'reset' })}
                  >
                    重置自限额
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setAction({ key: k, kind: 'delete' })}
                  >
                    撤销
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
            <DialogTitle>{edit ? '编辑 API Key' : '创建 API Key'}</DialogTitle>
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
            {me.data?.role === 'admin' && !edit ? (
              <Label>
                所属用户
                <SearchSelect
                  label='所属用户'
                  value={form.user_id}
                  options={(users.data?.items || []).map((u) => ({
                    id: u.id,
                    name: u.username,
                  }))}
                  allLabel='当前站长'
                  searchPlaceholder='搜索所属用户…'
                  onChange={(id) =>
                    setForm({ ...form, user_id: id || '', group_id: '' })
                  }
                />
              </Label>
            ) : null}
            <Label>
              名称
              <Input
                ref={nameInput}
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Label>
            <Label>
              服务分组
              <SearchSelect
                label='服务分组'
                value={form.group_id}
                options={[
                  ...(me.data?.role === 'admin' &&
                  (!form.user_id ||
                    users.data?.items?.find((u) => u.id === form.user_id)
                      ?.role === 'admin')
                    ? [
                        {
                          id: '__platform__',
                          name: '站长自用 Key（不扣用户余额）',
                        },
                      ]
                    : []),
                  ...availableGroups.map((g) => ({
                    id: String(g.id),
                    name: `${g.name} · ${g.rate_multiplier ?? '—'}×`,
                  })),
                ]}
                searchPlaceholder='搜索服务分组…'
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
                仅供站长内部测试和自用，使用平台可调度资源，不扣用户钱包。Key
                的次数和金额上限仍生效；此 Key
                不能管理控制台，请勿发给普通用户。
              </p>
            )}
            {!edit && (
              <Label>
                自定义密钥（可选）
                <Input
                  type='password'
                  autoComplete='off'
                  placeholder='留空自动生成，至少 16 位字母、数字、下划线或短横线'
                  value={form.custom_key}
                  onChange={(e) =>
                    setForm({ ...form, custom_key: e.target.value })
                  }
                />
              </Label>
            )}
            <h3 className='border-t pt-4 text-sm font-semibold'>用量限制</h3>
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
              0 = 不限制对应的 Key 限额。Key RPM、用户总 RPM、用户在当前分组的
              RPM 同时生效；多建 Key 不能绕过用户与分组上限。消费限额单位均为
              USD，5 小时／24 小时／7 天为滚动金额窗口。
            </p>
            <h3 className='border-t pt-4 text-sm font-semibold'>
              有效期与访问限制
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
                  {days} 天
                </Button>
              ))}
              <Button
                type='button'
                size='sm'
                variant='ghost'
                onClick={() => setForm({ ...form, expires_at: '' })}
              >
                不过期
              </Button>
            </div>
            <Label>
              到期时间（UTC）
              <Input
                type='datetime-local'
                value={form.expires_at}
                onChange={(e) =>
                  setForm({ ...form, expires_at: e.target.value })
                }
              />
            </Label>
            <Label>
              IP 白名单（IP/CIDR，逗号分隔）
              <Input
                value={form.ip_whitelist}
                onChange={(e) =>
                  setForm({ ...form, ip_whitelist: e.target.value })
                }
              />
            </Label>
            <Label>
              IP 黑名单
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
                取消
              </Button>
              <Button disabled={mutation.isPending || !form.group_id}>
                保存
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
            ? '轮换 Key'
            : action?.kind === 'delete'
              ? '撤销 Key'
              : '重置 Key 自限额'
        }
        desc={
          action?.kind === 'reset'
            ? '仅重置这把 Key 的保护计数，不退还消费、不重置套餐。'
            : '旧密钥将无法再使用，历史消费记录保留。'
        }
        confirmText='确认'
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

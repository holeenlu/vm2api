import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchSelect } from '@/components/search-select'
import { usersQueryOptions } from '@/features/users/queries'
import type { CommercialGroup } from './queries'

type Override = {
  user_id: string
  username: string
  rate_multiplier: number | null
  rpm_limit: number | null
}
export function GroupUserOverrides({
  group,
  field,
  onClose,
}: {
  group: CommercialGroup
  field: 'rate_multiplier' | 'rpm_limit'
  onClose: () => void
}) {
  const qc = useQueryClient()
  const users = useQuery(usersQueryOptions())
  const [user, setUser] = useState<string>()
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  const label = field === 'rpm_limit' ? '专属 RPM' : '专属倍率'
  const defaultValue =
    field === 'rpm_limit' ? group.rpm_limit : group.rate_multiplier
  const query = useQuery({
    queryKey: ['panel', 'groups', group.id, 'overrides'],
    queryFn: () =>
      api<{ items: Override[] }>(
        `/api/panel/groups/${group.id}/user-overrides`
      ),
  })
  const change = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number | null }) =>
      api(`/api/panel/groups/${group.id}/user-overrides/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: amount }),
      }),
    onSuccess: async () => {
      toast.success('已保存')
      setUser(undefined)
      setValue('')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const rows = (query.data?.items || []).filter(
    (r) =>
      r[field] != null &&
      r.username.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            分组{label}管理 · {group.name}
          </DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          分组默认：
          {field === 'rpm_limit'
            ? `${group.rpm_limit || 0} RPM`
            : `${group.rate_multiplier}×`}
          。
          {field === 'rpm_limit'
            ? '0 = 不限制此分组 RPM；用户总 RPM 仍生效。'
            : '0 = 免费。'}
          移除专属设置后继承分组默认值。设置不改变用户的分组访问授权。
        </p>
        <form
          className='flex flex-wrap items-end gap-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (user && value !== '')
              change.mutate({ id: user, amount: Number(value) })
          }}
        >
          <div className='min-w-48 flex-1 space-y-2'>
            <p className='text-sm font-medium'>用户</p>
            <SearchSelect
              label='选择用户'
              value={user}
              loading={users.isLoading || query.isLoading}
              options={(query.isSuccess ? users.data?.items || [] : []).map(
                (u) => ({
                  id: u.id,
                  name: u.username,
                })
              )}
              searchPlaceholder='搜索用户名称或 ID…'
              onChange={(id) => {
                setUser(id)
                const row = query.data?.items.find((r) => r.user_id === id)
                setValue(id ? String(row?.[field] ?? defaultValue ?? 0) : '')
              }}
            />
          </div>
          <div className='w-36 space-y-2'>
            <Label htmlFor='group-override-value'>
              {label}
              {field === 'rate_multiplier' ? '（×）' : ''}
            </Label>
            <Input
              id='group-override-value'
              aria-label={label}
              type='number'
              min='0'
              max={field === 'rpm_limit' ? 1000000 : 1000}
              step={field === 'rpm_limit' ? 1 : 0.01}
              value={value}
              disabled={!user}
              required
              placeholder='先选择用户'
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button disabled={!user || value === '' || change.isPending}>
            保存
          </Button>
        </form>
        <Input
          aria-label='搜索已设置用户'
          placeholder='搜索已设置用户…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {query.error && <p role='alert'>{query.error.message}</p>}
        <div className='max-h-80 space-y-2 overflow-auto'>
          {rows.map((row) => (
            <div
              key={row.user_id}
              className='flex items-center gap-3 rounded border p-3 text-sm'
            >
              <span className='flex-1'>{row.username}</span>
              <span>
                {row[field]}
                {field === 'rate_multiplier' ? '×' : ' RPM'}
              </span>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setUser(row.user_id)
                  setValue(String(row[field]))
                }}
              >
                编辑
              </Button>
              <Button
                variant='ghost'
                size='sm'
                disabled={change.isPending}
                onClick={() => change.mutate({ id: row.user_id, amount: null })}
              >
                恢复默认
              </Button>
            </div>
          ))}
          {!query.isLoading && !rows.length && (
            <p className='p-6 text-center text-muted-foreground'>
              暂无匹配的{label}设置
            </p>
          )}
        </div>
        <Button variant='outline' onClick={onClose}>
          关闭
        </Button>
      </DialogContent>
    </Dialog>
  )
}

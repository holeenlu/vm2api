import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { SearchSelect } from '@/components/search-select'
import { meQueryOptions } from '@/features/auth/queries'
import { groupsQueryOptions } from '@/features/groups/queries'
import { usersQueryOptions } from '@/features/users/queries'

type Subscription = {
  id: string
  user_id: string
  group_id: number
  group_name: string
  status: string
  starts_at: string
  expires_at: string | null
  windows: { period: string; used: number; limit: number }[]
}
export function SubscriptionsPage() {
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'admin'
  const qc = useQueryClient()
  const groups = useQuery(groupsQueryOptions())
  const users = useQuery({ ...usersQueryOptions(), enabled: admin })
  const q = useQuery({
    queryKey: ['panel', 'subscriptions'],
    queryFn: () => api<{ items: Subscription[] }>('/api/panel/subscriptions'),
  })
  const [user, setUser] = useState('')
  const [group, setGroup] = useState('')
  const [expires, setExpires] = useState('')
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: unknown }) =>
      api('/api/panel/subscriptions' + (id ? '/' + id : ''), {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success('套餐已保存')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <PageHeader
      title='套餐权益'
      description='套餐按分组授权；24 小时、7 天和 30 天为滚动消费窗口，与上游额度独立。'
    >
      {admin ? (
        <form
          className='mb-5 flex flex-wrap gap-3 rounded border p-4'
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate({
              body: {
                user_id: user,
                group_id: Number(group),
                expires_at: expires ? new Date(expires).toISOString() : null,
              },
            })
          }}
        >
          <SearchSelect
            className='mb-3 min-w-56'
            label='套餐用户'
            searchPlaceholder='搜索套餐用户…'
            value={user}
            options={(users.data?.items || [])
              .filter((u) => u.role === 'user')
              .map((u) => ({ id: u.id, name: u.username }))}
            onChange={(value) => {
              setUser(value || '')
            }}
          />
          <SearchSelect
            className='mb-3 min-w-56'
            label='套餐分组'
            searchPlaceholder='搜索套餐分组…'
            emptyLabel='没有套餐分组，请先将分组计费方式设为套餐'
            value={group}
            options={(groups.data?.items || [])
              .filter((g) => g.subscription_type === 'subscription')
              .map((g) => ({ id: String(g.id), name: g.name }))}
            onChange={(value) => {
              setGroup(value || '')
            }}
          />
          <Input
            aria-label='套餐到期时间'
            className='w-56'
            type='datetime-local'
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
          <Button disabled={mutation.isPending || !user || !group}>
            发放套餐
          </Button>
        </form>
      ) : null}
      {q.error ? <p className='text-destructive'>{q.error.message}</p> : null}
      <div className='space-y-3'>
        {q.data?.items.map((s) => (
          <section key={s.id} className='space-y-3 rounded border p-4'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h2 className='font-semibold'>
                  {s.group_name} · {s.status}
                </h2>
                {admin ? (
                  <p className='text-xs text-muted-foreground'>
                    {users.data?.items?.find((u) => u.id === s.user_id)
                      ?.username || '已删除用户'}
                  </p>
                ) : null}
                <p className='text-sm'>
                  {new Date(s.starts_at).toLocaleString()} —{' '}
                  {s.expires_at
                    ? new Date(s.expires_at).toLocaleString()
                    : '长期有效'}
                </p>
              </div>
              {admin && s.status !== 'revoked' ? (
                <div className='space-x-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      mutation.mutate({
                        id: s.id,
                        body: {
                          status:
                            s.status === 'active' ? 'suspended' : 'active',
                        },
                      })
                    }
                  >
                    {s.status === 'active' ? '暂停' : '恢复'}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      mutation.mutate({ id: s.id, body: { status: 'revoked' } })
                    }
                  >
                    撤销
                  </Button>
                </div>
              ) : null}
            </div>
            <div className='grid gap-3 sm:grid-cols-3'>
              {s.windows.map((w) => (
                <div key={w.period} className='rounded bg-muted/40 p-3 text-sm'>
                  {w.period === 'daily'
                    ? '24 小时'
                    : w.period === 'weekly'
                      ? '7 天'
                      : '30 天'}
                  ：{w.used.toFixed(6)} / {w.limit || '不限'} USD
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {!q.isLoading && !q.data?.items.length ? (
        <p className='p-6 text-muted-foreground'>暂无套餐</p>
      ) : null}
    </PageHeader>
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { systemDateTimeToIso, SYSTEM_TIMEZONE } from '@/lib/system-time'
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
  const { t } = useTranslation('subscriptions')
  const statusLabels: Record<string, string> = {
    active: t('statusActive'),
    suspended: t('statusSuspended'),
    revoked: t('statusRevoked'),
  }

  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'super_admin'
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
      toast.success(t('subscriptions:saved'))
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <PageHeader
      title={t('subscriptions:title')}
      description={t('subscriptions:description')}
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
                expires_at: expires ? systemDateTimeToIso(expires) : null,
              },
            })
          }}
        >
          <SearchSelect
            className='mb-3 min-w-56'
            label={t('subscriptions:user')}
            searchPlaceholder={t('subscriptions:searchUser')}
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
            label={t('subscriptions:group')}
            searchPlaceholder={t('subscriptions:searchGroup')}
            emptyLabel={t('subscriptions:noSubscriptionGroups')}
            value={group}
            options={(groups.data?.items || [])
              .filter((g) => g.subscription_type === 'subscription')
              .map((g) => ({ id: String(g.id), name: g.name }))}
            onChange={(value) => {
              setGroup(value || '')
            }}
          />
          <Input
            aria-label={t('subscriptions:expiry')}
            className='w-56'
            type='datetime-local'
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
          <Button disabled={mutation.isPending || !user || !group}>
            {t('subscriptions:grant')}
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
                  {s.group_name} · {statusLabels[s.status] ?? s.status}
                </h2>
                {admin ? (
                  <p className='text-xs text-muted-foreground'>
                    {users.data?.items?.find((u) => u.id === s.user_id)
                      ?.username || t('subscriptions:deletedUser')}
                  </p>
                ) : null}
                <p className='text-sm'>
                  {new Date(s.starts_at).toLocaleString(i18n.language, {
                    timeZone: SYSTEM_TIMEZONE,
                  })}{' '}
                  —{' '}
                  {s.expires_at
                    ? new Date(s.expires_at).toLocaleString(i18n.language, {
                        timeZone: SYSTEM_TIMEZONE,
                      })
                    : t('subscriptions:noExpiry')}
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
                    {s.status === 'active'
                      ? t('subscriptions:suspend')
                      : t('subscriptions:resume')}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      mutation.mutate({ id: s.id, body: { status: 'revoked' } })
                    }
                  >
                    {t('subscriptions:revoke')}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className='grid gap-3 sm:grid-cols-3'>
              {s.windows.map((w) => (
                <div key={w.period} className='rounded bg-muted/40 p-3 text-sm'>
                  {t('subscriptions:windowUsage', {
                    period: t(
                      w.period === 'daily'
                        ? 'daily'
                        : w.period === 'weekly'
                          ? 'weekly'
                          : 'monthly'
                    ),
                    used: w.used.toFixed(6),
                    limit: w.limit || t('subscriptions:unlimited'),
                  })}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {!q.isLoading && !q.data?.items.length ? (
        <p className='p-6 text-muted-foreground'>{t('subscriptions:empty')}</p>
      ) : null}
    </PageHeader>
  )
}

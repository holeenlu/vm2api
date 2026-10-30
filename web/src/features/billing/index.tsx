import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { SearchSelect } from '@/components/search-select'
import { StatCard } from '@/components/stat-card'
import { meQueryOptions } from '@/features/auth/queries'
import { usersQueryOptions } from '@/features/users/queries'

type Ledger = {
  id: string
  user_id: string
  user_name?: string | null
  amount: number
  balance_after: number
  reason: string
  created_at: string
  can_reverse?: boolean
}
export function BillingPage() {
  const { t } = useTranslation('billing')

  const me = useQuery(meQueryOptions())
  const canWrite = me.data?.role === 'super_admin'
  const admin = me.data?.role === 'super_admin' || me.data?.role === 'admin'
  const qc = useQueryClient()
  const users = useQuery({ ...usersQueryOptions(), enabled: admin })
  const [userId, setUserId] = useState('')
  const [cursors, setCursors] = useState<{ at: string; id: string }[]>([])
  const cursor = cursors[cursors.length - 1]
  const q = useQuery({
    queryKey: ['panel', 'billing', admin, userId, cursor],
    queryFn: () =>
      api<{
        balance?: number
        available?: number
        wallet_domain_id?: string | null
        items: Ledger[]
      }>(
        '/api/panel/billing?' +
          new URLSearchParams({
            ...(admin && userId ? { user_id: userId } : {}),
            ...(cursor ? { before: cursor.at, before_id: cursor.id } : {}),
          })
      ),
  })
  const [reason, setReason] = useState('')
  const [reverse, setReverse] = useState<Ledger | null>(null)
  const change = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      api(path, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      toast.success(t('billing:success'))
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <PageHeader
      title={t('billing:title')}
      description={t('billing:description')}
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {admin ? (
        <SearchSelect
          className='mb-3 min-w-56'
          label={t('billing:user')}
          searchPlaceholder={t('billing:searchUser')}
          value={userId}
          options={(users.data?.items || []).map((u) => ({
            id: u.id,
            name: u.username,
          }))}
          onChange={(value) => {
            setUserId(value || '')
            setCursors([])
          }}
          allLabel={t(
            me.data?.role === 'admin'
              ? 'billing:domainTransactions'
              : 'billing:allTransactions'
          )}
        />
      ) : null}
      {me.data && !canWrite ? (
        <div className='mb-5 grid gap-4 sm:grid-cols-2'>
          <StatCard
            label={
              q.data?.wallet_domain_id
                ? t('billing:sharedBalance')
                : t('billing:accountBalance')
            }
            value={q.data?.balance?.toFixed(6) ?? '—'}
          />
          <StatCard
            label={t('billing:available')}
            value={q.data?.available?.toFixed(6) ?? '—'}
          />
        </div>
      ) : null}
      <div className='overflow-auto rounded border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                t('billing:time'),
                ...(admin ? [t('billing:username')] : []),
                t('billing:kind'),
                t('billing:amount'),
                t('billing:balanceAfter'),
                t('billing:reason'),
              ].map((v) => (
                <th key={v} className='p-3 text-left'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((r) => (
              <tr key={r.id} className='border-b'>
                <td className='p-3'>
                  {new Date(r.created_at).toLocaleString(i18n.language)}
                </td>
                {admin ? (
                  <td className='p-3 text-sm' title={r.user_id}>
                    {r.user_name ||
                      users.data?.items?.find((u) => u.id === r.user_id)
                        ?.username ||
                      t('billing:deletedUser')}
                  </td>
                ) : null}
                <td className='p-3'>
                  {t(
                    r.amount < 0
                      ? 'billing:balanceDecrease'
                      : 'billing:balanceIncrease'
                  )}
                </td>
                <td
                  className={`p-3 tabular-nums ${r.amount < 0 ? 'text-destructive' : r.amount > 0 ? 'text-primary' : ''}`}
                >
                  {r.amount > 0 ? '+' : ''}
                  {r.amount.toFixed(6)}
                </td>
                <td className='p-3 tabular-nums'>
                  {r.balance_after.toFixed(6)}
                </td>
                <td className='p-3'>
                  {r.reason}
                  {canWrite && r.can_reverse && r.amount !== 0 ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => {
                        setReverse(r)
                        setReason('')
                      }}
                    >
                      {t('billing:reverse')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.isLoading && !q.data?.items.length ? (
          <p className='p-6 text-center text-muted-foreground'>
            {t('billing:noTransactions')}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!reverse}
        onOpenChange={(v) => !v && setReverse(null)}
        title={t('billing:reverseTitle')}
        desc={t('billing:reverseDescription')}
        confirmText={t('billing:confirmReverse')}
        disabled={!reason.trim()}
        handleConfirm={() => {
          if (reverse)
            change.mutate({
              path: '/api/panel/billing/ledger/' + reverse.id + '/reverse',
              body: { reason },
            })
          setReverse(null)
        }}
      >
        <Input
          aria-label={t('billing:reversalReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('billing:reversalPlaceholder')}
        />
      </ConfirmDialog>
      <div className='mt-4 flex gap-3'>
        <Button
          variant='outline'
          disabled={!cursors.length}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          {t('billing:newer')}
        </Button>
        <Button
          variant='outline'
          disabled={(q.data?.items.length || 0) < 50}
          onClick={() => {
            const last = q.data?.items[(q.data?.items.length || 0) - 1]
            if (last)
              setCursors([...cursors, { at: last.created_at, id: last.id }])
          }}
        >
          {t('billing:older')}
        </Button>
      </div>
    </PageHeader>
  )
}

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
  kind: string
  amount: number
  balance_after: number
  reason: string
  created_at: string
}
type Pending = {
  request_id: string
  user_id: string
  status: string
  reserved_micros: number
  model: string
}
export function BillingPage() {
  const { t } = useTranslation('billing')
  const kindLabels: Record<string, string> = {
    adjustment: t('ledgerAdjustment'),
    redeem: t('ledgerRedeem'),
    usage: t('ledgerUsage'),
    reversal: t('ledgerReversal'),
  }
  const pendingLabels: Record<string, string> = {
    pending: t('pending'),
    pending_usage: t('pendingUsage'),
    pending_pricing: t('pendingPricing'),
  }

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
        balance: number
        reserved?: number
        available?: number
        items: Ledger[]
        pending?: Pending[]
      }>(
        '/api/panel/billing?' +
          new URLSearchParams({
            ...(admin && userId ? { user_id: userId } : {}),
            ...(cursor ? { before: cursor.at, before_id: cursor.id } : {}),
          })
      ),
  })
  const codes = useQuery({
    queryKey: ['panel', 'redeem-codes'],
    queryFn: () =>
      api<{
        items: { id: number; code: string; value: number; status: string }[]
      }>('/api/panel/redeem-codes'),
    enabled: canWrite,
  })
  const [code, setCode] = useState('')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [reverse, setReverse] = useState<Ledger | null>(null)
  const change = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      api(path, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      setCode('')
      setValue('')
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
          allLabel={t('billing:allTransactions')}
        />
      ) : null}
      <div className='mb-5 grid gap-4 sm:grid-cols-3'>
        <StatCard
          label={
            admin ? t('billing:totalBalance') : t('billing:accountBalance')
          }
          value={q.data?.balance?.toFixed(6) ?? '—'}
        />
        <StatCard
          label={t('billing:reserved')}
          value={q.data?.reserved?.toFixed(6) ?? '—'}
        />
        <StatCard
          label={t('billing:available')}
          value={q.data?.available?.toFixed(6) ?? '—'}
        />
      </div>
      {canWrite ? (
        <form
          className='mb-5 flex flex-wrap gap-3 rounded border p-4'
          onSubmit={(e) => {
            e.preventDefault()
            change.mutate({
              path: '/api/panel/redeem-codes',
              body: { value: Number(value) },
            })
          }}
        >
          <Input
            className='w-52'
            aria-label={t('billing:codeAmount')}
            placeholder={t('billing:codeAmountPlaceholder')}
            type='number'
            min='0.000001'
            step='0.000001'
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button disabled={change.isPending}>
            {t('billing:generateCode')}
          </Button>
          <p className='w-full text-xs text-muted-foreground'>
            {t('billing:manualHelp')}
          </p>
        </form>
      ) : me.data?.role === 'user' ? (
        <form
          className='mb-5 flex gap-3 rounded border p-4'
          onSubmit={(e) => {
            e.preventDefault()
            change.mutate({ path: '/api/panel/redeem', body: { code } })
          }}
        >
          <Input
            aria-label={t('billing:creditCode')}
            placeholder={t('billing:codePlaceholder')}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button disabled={change.isPending}>{t('billing:redeem')}</Button>
        </form>
      ) : null}
      {canWrite && codes.data?.items.length ? (
        <details className='mb-5 rounded border p-3'>
          <summary>{t('billing:creditCode')}</summary>
          <div className='space-y-2 pt-3'>
            {codes.data.items.map((c) => (
              <div
                className='flex justify-between font-mono text-sm'
                key={c.id}
              >
                <span>{c.code}</span>
                <span>
                  {c.value} USD ·{' '}
                  {c.status === 'used'
                    ? t('statusUsed')
                    : c.status === 'unused'
                      ? t('statusUnused')
                      : c.status}
                </span>
              </div>
            ))}
          </div>
        </details>
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
                <td className='p-3'>{kindLabels[r.kind] ?? r.kind}</td>
                <td className='p-3 tabular-nums'>{r.amount.toFixed(6)}</td>
                <td className='p-3 tabular-nums'>
                  {r.balance_after.toFixed(6)}
                </td>
                <td className='p-3'>
                  {r.reason}
                  {canWrite && r.kind !== 'reversal' && r.amount !== 0 ? (
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
      {admin && q.data?.pending?.length ? (
        <section className='mt-6 space-y-3'>
          <h2 className='font-semibold'>{t('billing:pendingRequests')}</h2>
          <Input
            aria-label={t('billing:reconciliationReason')}
            placeholder={t('billing:manualReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {q.data.pending.map((r) => (
            <div
              key={r.request_id}
              className='flex flex-wrap items-center gap-3 rounded border p-3 text-sm'
            >
              <span className='flex-1'>
                {r.request_id} · {r.model} ·{' '}
                {pendingLabels[r.status] ?? r.status}
              </span>
              <Button
                variant='outline'
                disabled={change.isPending || !reason.trim()}
                onClick={() =>
                  change.mutate({
                    path:
                      '/api/panel/billing/requests/' +
                      encodeURIComponent(r.request_id),
                    body: { action: 'reprice', reason },
                  })
                }
              >
                {t('billing:reprice')}
              </Button>
              <Button
                variant='outline'
                disabled={change.isPending || !reason.trim()}
                onClick={() =>
                  change.mutate({
                    path:
                      '/api/panel/billing/requests/' +
                      encodeURIComponent(r.request_id),
                    body: { action: 'release', reason },
                  })
                }
              >
                {t('billing:release')}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
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

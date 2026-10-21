import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'admin'
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
    enabled: admin,
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
      toast.success('操作成功')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <PageHeader
      title='账务'
      description='账户资金和消费结算流水。请求用量明细请到使用记录查看。'
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {admin ? (
        <SearchSelect
          className='mb-3 min-w-56'
          label='账务用户'
          searchPlaceholder='搜索账务用户…'
          value={userId}
          options={(users.data?.items || []).map((u) => ({
            id: u.id,
            name: u.username,
          }))}
          onChange={(value) => {
            setUserId(value || '')
            setCursors([])
          }}
          allLabel='全站资金流水'
        />
      ) : null}
      <div className='mb-5 grid gap-4 sm:grid-cols-3'>
        <StatCard
          label={admin ? '用户总余额 USD' : '账户余额 USD'}
          value={q.data?.balance?.toFixed(6) ?? '—'}
        />
        <StatCard
          label='在途预留 USD'
          value={q.data?.reserved?.toFixed(6) ?? '—'}
        />
        <StatCard
          label='可用余额 USD'
          value={q.data?.available?.toFixed(6) ?? '—'}
        />
      </div>
      {admin ? (
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
            aria-label='充值码金额'
            placeholder='充值码金额 USD'
            type='number'
            min='0.000001'
            step='0.000001'
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button disabled={change.isPending}>生成充值码</Button>
          <p className='w-full text-xs text-muted-foreground'>
            手工充值与扣款在“用户 → 余额与流水”中操作，记录原因和幂等标识。
          </p>
        </form>
      ) : (
        <form
          className='mb-5 flex gap-3 rounded border p-4'
          onSubmit={(e) => {
            e.preventDefault()
            change.mutate({ path: '/api/panel/redeem', body: { code } })
          }}
        >
          <Input
            aria-label='充值码'
            placeholder='输入充值码'
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button disabled={change.isPending}>兑换充值</Button>
        </form>
      )}
      {admin && codes.data?.items.length ? (
        <details className='mb-5 rounded border p-3'>
          <summary>充值码</summary>
          <div className='space-y-2 pt-3'>
            {codes.data.items.map((c) => (
              <div
                className='flex justify-between font-mono text-sm'
                key={c.id}
              >
                <span>{c.code}</span>
                <span>
                  {c.value} USD · {c.status}
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
                '时间',
                ...(admin ? ['用户'] : []),
                '类型',
                '金额 USD',
                '变更后余额',
                '原因',
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
                  {new Date(r.created_at).toLocaleString()}
                </td>
                {admin ? (
                  <td className='p-3 text-sm' title={r.user_id}>
                    {r.user_name ||
                      users.data?.items?.find((u) => u.id === r.user_id)
                        ?.username ||
                      '已删除用户'}
                  </td>
                ) : null}
                <td className='p-3'>{r.kind}</td>
                <td className='p-3 tabular-nums'>{r.amount.toFixed(6)}</td>
                <td className='p-3 tabular-nums'>
                  {r.balance_after.toFixed(6)}
                </td>
                <td className='p-3'>
                  {r.reason}
                  {admin && r.kind !== 'reversal' && r.amount !== 0 ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => {
                        setReverse(r)
                        setReason('')
                      }}
                    >
                      冲正
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.isLoading && !q.data?.items.length ? (
          <p className='p-6 text-center text-muted-foreground'>暂无资金流水</p>
        ) : null}
      </div>
      {admin && q.data?.pending?.length ? (
        <section className='mt-6 space-y-3'>
          <h2 className='font-semibold'>待对账请求</h2>
          <Input
            aria-label='对账处理原因'
            placeholder='填写人工处理原因'
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {q.data.pending.map((r) => (
            <div
              key={r.request_id}
              className='flex flex-wrap items-center gap-3 rounded border p-3 text-sm'
            >
              <span className='flex-1'>
                {r.request_id} · {r.model} · {r.status}
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
                按真实用量重新计价
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
                释放预留
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      <ConfirmDialog
        open={!!reverse}
        onOpenChange={(v) => !v && setReverse(null)}
        title='冲正资金流水'
        desc='追加一条反向流水，保留原明细；同一笔不能重复冲正。'
        confirmText='确认冲正'
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
          aria-label='冲正原因'
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder='填写冲正原因'
        />
      </ConfirmDialog>
      <div className='mt-4 flex gap-3'>
        <Button
          variant='outline'
          disabled={!cursors.length}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          较新流水
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
          更早流水
        </Button>
      </div>
    </PageHeader>
  )
}

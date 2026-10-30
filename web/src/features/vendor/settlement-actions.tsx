import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Statement = {
  id: string
  status: string
  amount_usdt: number
  paid_usdt?: number
}
export function SettlementActions({
  statement,
  basePath,
  onChanged,
}: {
  statement: Statement
  basePath: string
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [action, setAction] = useState<'confirm' | 'void' | 'payments' | null>(
    null
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [amount, setAmount] = useState(''),
    [key, setKey] = useState('')
  const open = (value: typeof action) => {
    setAction(value)
    setError('')
    setReason('')
    setAmount(
      String(Math.max(0, statement.amount_usdt - (statement.paid_usdt || 0)))
    )
    setKey(crypto.randomUUID())
  }
  const title =
    action === 'payments'
      ? t('recordPayment')
      : action === 'void'
        ? t('voidStatement')
        : t('confirmStatement')
  const submit = async () => {
    if (!action) return
    setBusy(true)
    setError('')
    try {
      await api(`${basePath}/${statement.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'payments'
            ? { amount_usdt: Number(amount), reason, idempotency_key: key }
            : action === 'void'
              ? { reason }
              : {}
        ),
      })
      await onChanged()
      setAction(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className='flex flex-wrap gap-2'>
        {['draft', 'review'].includes(statement.status) && (
          <Button size='sm' variant='outline' onClick={() => open('confirm')}>
            {t('confirmStatement')}
          </Button>
        )}
        {['confirmed', 'partial'].includes(statement.status) && (
          <Button size='sm' variant='outline' onClick={() => open('payments')}>
            {t('recordPayment')}
          </Button>
        )}
        {['draft', 'review', 'confirmed'].includes(statement.status) && (
          <Button size='sm' variant='outline' onClick={() => open('void')}>
            {t('voidStatement')}
          </Button>
        )}
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(value) => {
          if (!value && !busy) setAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t(
                action === 'payments' ? 'paymentHint' : 'confirmStatementHint'
              )}
            </DialogDescription>
          </DialogHeader>
          {action === 'payments' && (
            <label className='grid gap-2 text-sm'>
              {t('paymentAmount')}
              <Input
                type='number'
                min='0.000001'
                step='0.000001'
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          )}
          {action !== 'confirm' && (
            <label className='grid gap-2 text-sm'>
              {t(action === 'payments' ? 'paymentReference' : 'voidReason')}
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p role='alert' className='text-sm text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={busy}
              variant='outline'
              onClick={() => setAction(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={
                busy ||
                (action !== 'confirm' && !reason.trim()) ||
                (action === 'payments' &&
                  (!Number.isFinite(Number(amount)) || Number(amount) <= 0))
              }
              onClick={() => void submit()}
            >
              {t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

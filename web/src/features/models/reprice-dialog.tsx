import { useState } from 'react'
import { format, subDays } from 'date-fns'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { RepriceResult } from '@/types/panel-pricing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invalidatePricing } from '@/features/models/queries'

function toLocal(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm")
}

function defaultRange() {
  const until = new Date()
  return {
    since: toLocal(subDays(until, 7)),
    until: toLocal(until),
  }
}

export function RepriceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('models')

  const qc = useQueryClient()
  const [range, setRange] = useState(defaultRange)
  const [result, setResult] = useState<RepriceResult | null>(null)

  const reprice = useMutation({
    mutationFn: () => {
      const since = new Date(range.since)
      const until = new Date(range.until)
      if (
        !Number.isFinite(since.getTime()) ||
        !Number.isFinite(until.getTime())
      ) {
        throw new Error(t('models:invalidTime'))
      }
      if (since >= until) throw new Error(t('models:invalidTimeRange'))
      return api<RepriceResult>('/api/panel/pricing/reprice', {
        method: 'POST',
        body: JSON.stringify({
          since: since.toISOString(),
          until: until.toISOString(),
        }),
      })
    },
    onSuccess: async (data) => {
      setResult(data)
      toast.success(
        t('models:repriceResult', {
          count: data.rows,
          changed: data.changed,
          unpriced: data.still_unpriced,
        })
      )
      await invalidatePricing(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setResult(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('models:reprice')}</DialogTitle>
          <DialogDescription>{t('models:repriceHint')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='reprice-since'>{t('models:start')}</Label>
            <Input
              id='reprice-since'
              type='datetime-local'
              value={range.since}
              onChange={(e) =>
                setRange((prev) => ({ ...prev, since: e.target.value }))
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='reprice-until'>{t('models:end')}</Label>
            <Input
              id='reprice-until'
              type='datetime-local'
              value={range.until}
              onChange={(e) =>
                setRange((prev) => ({ ...prev, until: e.target.value }))
              }
            />
          </div>
        </div>
        {result ? (
          <dl className='grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 text-sm'>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('models:processedRows')}
              </dt>
              <dd className='font-mono tabular-nums'>{result.rows}</dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('models:changedRows')}
              </dt>
              <dd className='font-mono tabular-nums'>{result.changed}</dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('models:stillUnpriced')}
              </dt>
              <dd className='font-mono tabular-nums'>
                {result.still_unpriced}
              </dd>
            </div>
            <div>
              <dt className='text-xs text-muted-foreground'>
                {t('models:usdDifference')}
              </dt>
              <dd className='font-mono tabular-nums'>
                {result.delta_usd > 0 ? '+' : ''}
                {fmtUsd(result.delta_usd, 4)}
              </dd>
            </div>
          </dl>
        ) : null}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            {t('models:close')}
          </Button>
          <Button
            type='button'
            disabled={reprice.isPending}
            onClick={() => reprice.mutate()}
          >
            {reprice.isPending
              ? t('models:repricing')
              : t('models:startReprice')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { systemDate } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DateRangePicker,
  dateRangeValueForPreset,
} from '@/components/date-range-picker'
import { PricingBreakdown } from '@/features/vendor/pricing-breakdown'
import { ROOT, amount, selectClass, type Supplier, type Preview } from './model'

export function SettlementEditor({
  suppliers,
  initialVendor,
  close,
  saved,
}: {
  suppliers: Supplier[]
  initialVendor: string
  close: () => void
  saved: () => Promise<void>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [vendorId, setVendorId] = useState(
    suppliers.find((v) => v.id === initialVendor && v.tier === 1)?.id || ''
  )
  const [start, setStart] = useState(systemDate(Date.now() - 7 * 86400000)),
    [end, setEnd] = useState(systemDate())
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const submit = async (create: boolean) => {
    setError('')
    setBusy(true)
    try {
      const body = { vendor_id: vendorId, start_date: start, end_date: end }
      if (create) {
        await api(`${ROOT}/settlements`, {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            expected_amount_usdt: preview?.amount_usdt,
            preview_token: preview?.preview_token,
          }),
        })
        await saved()
        close()
      } else
        setPreview(
          await api<Preview>(`${ROOT}/settlements/preview`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <DialogTitle>{t('createStatement')}</DialogTitle>
          <DialogDescription>{t('settlementHint')}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4'>
          <label className='grid gap-2 text-sm'>
            {t('supplier')}
            <select
              className={selectClass}
              value={vendorId}
              onChange={(e) => {
                setVendorId(e.target.value)
                setPreview(null)
              }}
            >
              <option value=''>{t('selectSupplier')}</option>
              {suppliers
                .filter((v) => v.tier === 1)
                .map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </label>
          <div className='grid gap-2 text-sm'>
            <span>{t('startDate')}</span>
            <DateRangePicker
              value={{ startDate: start, endDate: end }}
              disableFuture
              allowClear={false}
              presets={[
                'today',
                'yesterday',
                '7days',
                '30days',
                'thisMonth',
                'lastMonth',
              ].map((id) => ({
                id,
                label: t('range.' + id),
                value: dateRangeValueForPreset(
                  id as Parameters<typeof dateRangeValueForPreset>[0]
                ),
              }))}
              labels={{
                empty: t('selectDateRange'),
                clear: t('clear'),
              }}
              onChange={(value) => {
                if (value.startDate && value.endDate) {
                  setStart(value.startDate)
                  setEnd(value.endDate)
                  setPreview(null)
                }
              }}
            />
          </div>
          <p className='text-xs text-muted-foreground'>{t('dateHint')}</p>
          {preview && (
            <div className='space-y-2 rounded-lg border bg-muted/30 p-4 text-sm'>
              <div>
                {t('requests')}: {amount(preview.usage.requests)}
              </div>
              <div>
                {t('costUsd')}: ${amount(preview.usage.cost_usd)}
              </div>
              <p className='text-xs text-muted-foreground'>
                {t('pricingCalculationBasis')}
              </p>
              <PricingBreakdown snapshot={preview} />
              <div className='text-lg font-semibold'>
                {t('totalUsdt')}: {amount(preview.amount_usdt)}
              </div>
            </div>
          )}
          {error && (
            <p role='alert' className='text-destructive'>
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            disabled={busy || !vendorId || !start || !end}
            onClick={() => void submit(!!preview)}
          >
            {t(preview ? 'createStatement' : 'preview')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

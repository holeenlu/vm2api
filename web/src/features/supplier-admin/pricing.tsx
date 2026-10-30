import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { ROOT } from './model'

type Rule = {
  id: string
  version: number
  openai_price: number
  claude_price: number
  exchange_rate: number
  effective_date: string
  effective_at: string
  state: 'active' | 'scheduled' | 'historical' | 'superseded'
}
type Schedule = { timezone: string; current: Rule | null; items: Rule[] }
const today = () => {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) =>
    parts.find((p) => p.type === type)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}
export function SupplierPricingPage() {
  const { t } = useTranslation('supplierAdmin'),
    qc = useQueryClient()
  const query = useQuery({
    queryKey: ['supplier-admin', 'pricing'],
    queryFn: () => api<Schedule>(ROOT + '/pricing'),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  return (
    <PageHeader
      title={t('pricing')}
      description={t('pricingDescription')}
      fluid
    >
      <div className='space-y-5'>
        {query.isPending ? (
          <p>{t('loading')}</p>
        ) : query.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {query.error.message}
          </p>
        ) : (
          query.data && (
            <>
              <div className='rounded-xl border bg-card p-5 text-sm'>
                <p className='font-semibold'>
                  {t(
                    query.data.current ? 'pricingCurrent' : 'pricingNoCurrent'
                  )}
                </p>
                {query.data.current && (
                  <p className='mt-2 text-muted-foreground'>
                    {t('pricingCurrentSummary', {
                      openai: query.data.current.openai_price,
                      claude: query.data.current.claude_price,
                      rate: query.data.current.exchange_rate,
                      date: query.data.current.effective_date,
                    })}
                  </p>
                )}
              </div>
              <PricingForm
                key={query.data.items.map((r) => r.id).join(',')}
                initial={query.data.current || query.data.items[0]}
                saved={async () => {
                  await qc.invalidateQueries({
                    queryKey: ['supplier-admin', 'pricing'],
                  })
                }}
              />
              <section className='overflow-hidden rounded-xl border bg-card'>
                <h3 className='border-b px-5 py-4 font-semibold'>
                  {t('pricingHistory')}
                </h3>
                <div className='overflow-x-auto'>
                  <table className='w-full text-sm'>
                    <thead className='bg-muted/20'>
                      <tr>
                        {[
                          'pricingVersion',
                          'pricingOpenAI',
                          'pricingClaude',
                          'pricingFx',
                          'pricingDate',
                          'status',
                        ].map((key) => (
                          <th
                            key={key}
                            className='px-4 py-3 text-start font-medium'
                          >
                            {t(key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {query.data.items.map((row) => (
                        <tr
                          key={row.id}
                          className='border-t [&_td]:px-4 [&_td]:py-3'
                        >
                          <td>{row.version}</td>
                          <td>{row.openai_price}</td>
                          <td>{row.claude_price}</td>
                          <td>{row.exchange_rate}</td>
                          <td>{row.effective_date}</td>
                          <td>{t('pricingState.' + row.state)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!query.data.items.length && (
                    <p className='p-6 text-sm text-muted-foreground'>
                      {t('pricingEmpty')}
                    </p>
                  )}
                </div>
              </section>
            </>
          )
        )}
      </div>
    </PageHeader>
  )
}
function PricingForm({
  initial,
  saved,
}: {
  initial?: Rule
  saved: () => Promise<unknown>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [form, setForm] = useState({
    openai_price: initial ? String(initial.openai_price) : '',
    claude_price: initial ? String(initial.claude_price) : '',
    exchange_rate: initial ? String(initial.exchange_rate) : '',
    effective_date: today(),
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    key = useRef(crypto.randomUUID())
  const change = (field: keyof typeof form, value: string) => {
    setForm({ ...form, [field]: value })
    key.current = crypto.randomUUID()
    setError('')
  }
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api(ROOT + '/pricing', {
        method: 'POST',
        body: JSON.stringify({ ...form, idempotency_key: key.current }),
      })
      toast.success(t('pricingSaved'))
      await saved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className='space-y-4 rounded-xl border bg-card p-5'
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <h3 className='font-semibold'>{t('pricingNewVersion')}</h3>
      <fieldset
        disabled={busy}
        className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'
      >
        {(['openai_price', 'claude_price', 'exchange_rate'] as const).map(
          (field, index) => (
            <label key={field} className='grid gap-2 text-sm'>
              {t(['pricingOpenAI', 'pricingClaude', 'pricingFx'][index])}
              <Input
                type='number'
                required
                min='0.0000000001'
                max='999999999999'
                step='any'
                value={form[field]}
                onChange={(e) => change(field, e.target.value)}
              />
            </label>
          )
        )}
        <label className='grid gap-2 text-sm'>
          {t('pricingDate')}
          <Input
            required
            type='date'
            value={form.effective_date}
            onChange={(e) => change('effective_date', e.target.value)}
          />
        </label>
      </fieldset>
      <p className='text-xs leading-5 text-muted-foreground'>
        {t('pricingHelp')}
      </p>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      <Button
        type='submit'
        disabled={
          busy ||
          !form.effective_date ||
          ![form.openai_price, form.claude_price, form.exchange_rate].every(
            (v) => Number.isFinite(Number(v)) && Number(v) > 0
          )
        }
      >
        {t(busy ? 'pricingSaving' : 'pricingSave')}
      </Button>
    </form>
  )
}

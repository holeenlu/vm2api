import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField as Label } from '@/components/form-field'
import type { MediaBillingForm } from './media-billing-model'

// 与服务端 media-pricing.mjs 的默认价一致：1K $0.134，2K ×1.5，4K ×2；网页搜索 $0.01/次
const DEFAULT_IMAGE = {
  image_price_1k: 0.134,
  image_price_2k: 0.201,
  image_price_4k: 0.268,
}
const DEFAULT_SEARCH = 0.01

const money = (n: number) => '$' + Number(n.toFixed(6))
const priceInput = (value: string) => (value === '' ? null : Number(value))

export function MediaBilling({
  value,
  rate,
  onChange,
}: {
  value: MediaBillingForm
  rate: number
  onChange: (next: MediaBillingForm) => void
}) {
  const { t } = useTranslation('groups')
  const imageRate = value.image_rate_independent
    ? value.image_rate_multiplier
    : rate
  const tiers = [
    ['1K', 'image_price_1k'],
    ['2K', 'image_price_2k'],
    ['4K', 'image_price_4k'],
  ] as const
  return (
    <div className='space-y-5'>
      <section className='space-y-3 border-t pt-4'>
        <div>
          <div className='text-sm font-medium'>{t('groups:imageBilling')}</div>
          <p className='text-xs text-muted-foreground'>
            {t('groups:imageBillingHelp')}
          </p>
        </div>
        <div className='grid gap-2 sm:grid-cols-2'>
          {(
            [
              'allow_image_generation',
              'image_rate_independent',
              'image_count_billing',
            ] as const
          ).map((field) => (
            <label key={field} className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={value[field]}
                onChange={(e) =>
                  onChange({ ...value, [field]: e.target.checked })
                }
              />
              {t(`groups:${field}`)}
            </label>
          ))}
        </div>
        {value.image_rate_independent ? (
          <Label>
            {t('groups:imageRateMultiplier')}
            <Input
              type='number'
              min='0'
              step='0.01'
              value={value.image_rate_multiplier}
              onChange={(e) =>
                onChange({
                  ...value,
                  image_rate_multiplier: Number(e.target.value),
                })
              }
            />
          </Label>
        ) : null}
        {value.image_count_billing ? (
          <>
            <div className='grid gap-4 sm:grid-cols-3'>
              {tiers.map(([tier, field]) => (
                <Label key={field}>
                  {tier} ($)
                  <Input
                    type='number'
                    min='0'
                    step='0.001'
                    placeholder={String(DEFAULT_IMAGE[field])}
                    value={value[field] ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        [field]: priceInput(e.target.value),
                      })
                    }
                  />
                </Label>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('groups:imageRateHelp')}
            </p>
            <div className='rounded-md bg-muted/50 p-3 text-xs'>
              <div className='mb-1 font-medium'>
                {t('groups:imagePricePreview')}
              </div>
              <div className='grid grid-cols-3 gap-2'>
                {tiers.map(([tier, field]) => (
                  <span key={field}>
                    {tier}:{' '}
                    {money((value[field] ?? DEFAULT_IMAGE[field]) * imageRate)}
                  </span>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </section>
      <section className='space-y-3 border-t pt-4'>
        <div className='text-sm font-medium'>
          {t('groups:webSearchBilling')}
        </div>
        <Label>
          {t('groups:webSearchPrice')}
          <Input
            type='number'
            min='0'
            step='0.001'
            placeholder={String(DEFAULT_SEARCH)}
            value={value.web_search_price_per_call ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                web_search_price_per_call: priceInput(e.target.value),
              })
            }
          />
        </Label>
        <p className='text-xs text-muted-foreground'>
          {t('groups:webSearchPriceHelp')}
        </p>
        <div className='rounded-md bg-muted/50 p-3 text-xs'>
          {t('groups:webSearchPricePreview', {
            price: money(
              (value.web_search_price_per_call ?? DEFAULT_SEARCH) * rate
            ),
          })}
        </div>
      </section>
    </div>
  )
}

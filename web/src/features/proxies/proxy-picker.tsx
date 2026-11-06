import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { proxyIsLocal, proxyLabel } from './proxy-sort'
import { proxiesQueryOptions } from './queries'

/** 不走代理。 */
export const PROXY_DIRECT = ''
/** 已存的手填代理地址（只有 proxy_url、没有 proxy_id）：沿用，不改动。 */
export const PROXY_SAVED = '__saved__'

/** 从代理池选一个出口；值为池里的 proxy id、PROXY_DIRECT 或 PROXY_SAVED。 */
export function ProxyPicker({
  value,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const { t } = useTranslation('proxies')
  const proxies = useQuery(proxiesQueryOptions())
  // Local egress has no forwardable URL (the server rejects it); "direct" covers it.
  const options = (proxies.data?.proxies || []).filter(
    (item) => item.id && !proxyIsLocal(item)
  )
  const [open, setOpen] = useState(false)

  const current =
    value === PROXY_DIRECT
      ? t('proxies:direct')
      : value === PROXY_SAVED
        ? t('proxies:savedProxyUrl')
        : (() => {
            const found = options.find((item) => item.id === value)
            if (found) return proxyLabel(found)
            return proxies.isLoading ? '…' : t('proxies:pickerUnavailable')
          })()

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn('justify-start font-normal', className)}
        >
          <span className='truncate'>{current}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='grid max-h-72 gap-1 overflow-auto p-2'
      >
        {value === PROXY_SAVED ? (
          <Button
            type='button'
            variant='secondary'
            className='justify-start'
            onClick={() => pick(PROXY_SAVED)}
          >
            {t('proxies:savedProxyUrl')}
          </Button>
        ) : null}
        <Button
          type='button'
          variant={value === PROXY_DIRECT ? 'secondary' : 'ghost'}
          className='justify-start'
          onClick={() => pick(PROXY_DIRECT)}
        >
          {t('proxies:direct')}
        </Button>
        {options.map((proxy) => (
          <Button
            key={proxy.id}
            type='button'
            variant={value === proxy.id ? 'secondary' : 'ghost'}
            className='justify-start'
            onClick={() => pick(proxy.id || PROXY_DIRECT)}
          >
            <span className='truncate'>{proxyLabel(proxy)}</span>
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

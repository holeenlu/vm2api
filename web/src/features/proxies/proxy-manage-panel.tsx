import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type { VmProxySnap } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ProxyPanel } from './proxy-panel'
import { SeatCells } from './proxy-seats'
import { proxyBoundIds } from './proxy-sort'
import { useRefreshProxies } from './queries'

const BIND_LIMITS = [1, 2, 3, 4, 5, 8, 10, 16, 20, 32]
const PROBE_MINS = [5, 10, 30, 60]
// The chosen upstream is tried first; the existing automatic fallback order
// is unchanged, including when a domain or custom HTTPS endpoint is selected.
const DNS_CHOICES = [
  {
    value: 'auto',
    get label() {
      return translate('proxies:automaticDns')
    },
  },
  { value: 'https://1.1.1.1/dns-query', label: 'Cloudflare DoH' },
  {
    value: 'https://cloudflare-dns.com/dns-query',
    get label() {
      return translate('proxies:cloudflareDoh')
    },
  },
  { value: 'https://8.8.8.8/dns-query', label: 'Google DoH' },
  {
    value: '8.8.8.8:53',
    get label() {
      return translate('proxies:googleTcpDns')
    },
  },
  {
    value: '1.1.1.1:53',
    get label() {
      return translate('proxies:cloudflareTcpDns')
    },
  },
]

type ConfigResult = {
  egress?: { proxy_id: string; ok: boolean; error?: string | null }[]
}

export function ProxyManagePanel({
  proxies,
  bindLimit,
  probeMin,
  dnsPrimary,
  dnsDisableSvcbHttps,
  followProxyTimezone,
}: {
  proxies: VmProxySnap[]
  bindLimit: number
  probeMin: number
  dnsPrimary: string
  dnsDisableSvcbHttps: boolean
  followProxyTimezone: boolean
}) {
  const { t: translate } = useTranslation('proxies')

  const refresh = useRefreshProxies()
  const [customDnsDraft, setCustomDnsDraft] = useState<string | null>(null)
  const maxUsed = proxies.reduce(
    (n, p) => Math.max(n, proxyBoundIds(p).length),
    0
  )

  const saveConfig = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<ConfigResult>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data, patch) => {
      const failed = (data.egress || []).filter((entry) => !entry.ok)
      if (failed.length) {
        toast.warning(
          translate('proxies:dnsSavedReloadFailed', {
            count: failed.length,
            p1: failed.map((entry) => entry.proxy_id).join('、'),
          })
        )
      } else if (
        patch.dns_primary != null ||
        patch.dns_disable_svcb_https != null
      ) {
        toast.success(translate('proxies:dnsSaved'))
      } else if (patch.bind_limit != null) {
        toast.success(
          translate('proxies:maxBindings', { count: String(patch.bind_limit) })
        )
      } else if (patch.probe_interval_min != null) {
        toast.success(
          translate('proxies:probeIntervalMinutes', {
            count: String(patch.probe_interval_min),
          })
        )
      } else {
        toast.success(translate('proxies:saved'))
      }
      await refresh()
      if (patch.dns_primary != null) setCustomDnsDraft(null)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  // 保存中的值先行显示，避免选中后按钮跳回旧值再跳到新值。
  const pending = saveConfig.isPending ? saveConfig.variables : undefined
  const limitShown = Number(pending?.bind_limit ?? bindLimit)
  const probeShown = Number(pending?.probe_interval_min ?? probeMin)
  const dnsShown = String(pending?.dns_primary ?? dnsPrimary)
  const dnsDisableShown = Boolean(
    pending?.dns_disable_svcb_https ?? dnsDisableSvcbHttps
  )
  const customDnsShown =
    customDnsDraft !== null ||
    !DNS_CHOICES.some((choice) => choice.value === dnsShown)
  const over = proxies.filter((p) => proxyBoundIds(p).length > limitShown)

  return (
    <ProxyPanel title={translate('proxies:poolSettings')} plain>
      <div className='space-y-5'>
        <fieldset>
          <legend className='flex w-full items-baseline justify-between text-xs font-medium'>
            {translate('proxies:maxBindingsLabel')}
            <span className='text-muted-foreground tabular-nums'>
              <Trans
                ns='proxies'
                i18nKey='capacityCalculation'
                values={{
                  proxies: proxies.length,
                  limit: limitShown,
                  total: proxies.length * limitShown,
                }}
                components={{
                  total: <b className='font-semibold text-foreground' />,
                }}
              />
            </span>
          </legend>
          <div className='mt-2 flex items-center gap-3'>
            <span className='inline-flex w-14 items-baseline gap-0.5 tabular-nums'>
              <span className='text-2xl leading-none font-[620] tracking-[-0.03em]'>
                {limitShown}
              </span>
              <span className='text-xs text-muted-foreground'>
                {translate('proxies:slotsUnit')}
              </span>
            </span>
            <SeatCells
              used={maxUsed}
              limit={limitShown}
              color='var(--status-ok-solid)'
              className='min-w-0 flex-1'
            />
          </div>
          <Segmented
            label={translate('proxies:maxBindingsAria')}
            options={BIND_LIMITS}
            value={limitShown}
            disabled={saveConfig.isPending}
            onChange={(value) => saveConfig.mutate({ bind_limit: value })}
            className='mt-2 grid-cols-5'
          />
          <p className='mt-1.5 text-[11px] text-muted-foreground'>
            {over.length
              ? translate('proxies:overCapacityHint', {
                  p0: over.length,
                  p1: limitShown,
                })
              : maxUsed
                ? translate('proxies:mostBoundHint', { count: maxUsed })
                : translate('proxies:lowerLimitHint')}
          </p>
        </fieldset>

        <fieldset>
          <legend className='text-xs font-medium'>
            {translate('proxies:autoProbeInterval')}
          </legend>
          <Segmented
            label={translate('proxies:autoProbeIntervalAria')}
            options={PROBE_MINS}
            value={probeShown}
            suffix={translate('proxies:minutesShort')}
            disabled={saveConfig.isPending}
            onChange={(value) =>
              saveConfig.mutate({ probe_interval_min: value })
            }
            className='mt-2 grid-cols-4'
          />
        </fieldset>

        <div>
          <label
            htmlFor='proxy-dns'
            className='flex items-baseline justify-between text-xs font-medium'
          >
            {translate('proxies:exitDns')}
            <span className='font-normal text-muted-foreground'>
              {translate('proxies:dnsFallbackHint')}
            </span>
          </label>
          <Select
            value={customDnsShown ? 'custom' : dnsShown}
            disabled={saveConfig.isPending}
            onValueChange={(value) => {
              if (value === 'custom') {
                setCustomDnsDraft(customDnsShown ? dnsShown : '')
              } else {
                setCustomDnsDraft(null)
                saveConfig.mutate({ dns_primary: value })
              }
            }}
          >
            <SelectTrigger id='proxy-dns' className='mt-2 h-8 w-full text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DNS_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
              <SelectItem value='custom'>
                {translate('proxies:customDoh')}
              </SelectItem>
            </SelectContent>
          </Select>
          {customDnsShown && (
            <form
              className='mt-2 space-y-2'
              onSubmit={(event) => {
                event.preventDefault()
                if (!saveConfig.isPending) {
                  saveConfig.mutate({ dns_primary: customDnsDraft ?? dnsShown })
                }
              }}
            >
              <label htmlFor='proxy-dns-url' className='text-xs font-medium'>
                {translate('proxies:customDohUrl')}
              </label>
              <Input
                id='proxy-dns-url'
                type='url'
                required
                title={translate('proxies:dohUrlRequired')}
                pattern='https://.+'
                value={customDnsDraft ?? dnsShown}
                onChange={(event) => setCustomDnsDraft(event.target.value)}
                disabled={saveConfig.isPending}
                placeholder={translate('proxies:dohExample')}
                aria-describedby='proxy-dns-url-help'
                className='h-8 text-xs'
              />
              <p
                id='proxy-dns-url-help'
                className='text-[11px] text-muted-foreground'
              >
                {translate('proxies:dohUrlHint')}
              </p>
              <Button
                type='submit'
                size='sm'
                variant='outline'
                disabled={saveConfig.isPending}
                loading={saveConfig.isPending}
              >
                {translate('proxies:saveDns')}
              </Button>
            </form>
          )}
        </div>

        <div className='flex items-start justify-between gap-3'>
          <div className='space-y-0.5'>
            <label
              htmlFor='proxy-dns-empty-types'
              className='block text-xs font-medium'
            >
              {translate('proxies:disableDnsTypes')}
            </label>
            <p
              id='proxy-dns-empty-types-help'
              className='text-[11px] text-muted-foreground'
            >
              {translate('proxies:disableDnsTypesHint')}
            </p>
          </div>
          <Switch
            id='proxy-dns-empty-types'
            checked={dnsDisableShown}
            disabled={saveConfig.isPending}
            onCheckedChange={(value) =>
              saveConfig.mutate({ dns_disable_svcb_https: value })
            }
            aria-describedby='proxy-dns-empty-types-help'
            className='mt-0.5'
          />
        </div>

        <label className='flex cursor-pointer items-start justify-between gap-3'>
          <span className='space-y-0.5'>
            <span className='block text-xs font-medium'>
              {translate('proxies:followProxyTimezone')}
            </span>
            <span className='block text-[11px] text-muted-foreground'>
              {translate('proxies:pinnedTimezoneHint')}
            </span>
          </span>
          <Switch
            checked={followProxyTimezone}
            onCheckedChange={(value) =>
              saveConfig.mutate({ follow_proxy_timezone: value })
            }
            aria-label={translate('proxies:followProxyTimezone')}
            className='mt-0.5'
          />
        </label>
      </div>
    </ProxyPanel>
  )
}

function Segmented({
  label,
  options,
  value,
  suffix,
  disabled,
  onChange,
  className,
}: {
  label: string
  options: number[]
  value: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
  className?: string
}) {
  useTranslation('proxies')

  return (
    <div
      role='group'
      aria-label={label}
      className={cn('grid gap-1 rounded-lg bg-muted/60 p-1', className)}
    >
      {options.map((n) => {
        const on = n === value
        return (
          <button
            key={n}
            type='button'
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(n)}
            className={cn(
              'h-7 rounded-md text-xs tabular-nums transition-colors disabled:cursor-wait',
              on
                ? 'bg-background font-semibold text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            )}
          >
            {n}
            {suffix ? (
              <span className='ms-px text-[10px] font-normal opacity-70'>
                {suffix}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

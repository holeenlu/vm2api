import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  localProxyText,
  localProxyOptsFromProxy,
  proxyHostLabel,
} from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { TabsContent } from '@/components/ui/tabs'
import { StatusMark } from '@/components/status-mark'
import { HealthDonut } from '@/features/overview/health-gauge'
import {
  proxyIsLocal,
  proxyLabel,
  proxyMatchesQuery,
  proxyStatusLabel,
} from '@/features/proxies/proxy-sort'
import {
  proxyFieldClass,
  proxyLatencyTone,
} from '@/features/proxies/proxy-tone'
import { useLocalProxyLabelOpts } from '@/features/proxies/use-vps-ip'
import { Field } from '@/features/vm/detail-section-primitives'
import { proxyHealthOf } from '@/features/vm/proxy-health'

type VmProxyTabProps = {
  vm: Vm
  proxy: VmProxySnap
  boundId: string
  free: VmProxySnap[]
  /** 整个池（父组件仍传入；标签已改走节点名，不再读出口 IP）。 */
  pool: VmProxySnap[]
  /** 已按候选回落过：不在 free 里的旧值不会传进来。 */
  bindId: string
  /** 只有管理员能绑定 / 解绑 / 测通 / 测地理 / 分配。 */
  canManage: boolean
  busy: (key: string) => boolean
  onBindIdChange: (id: string) => void
  onUnbind: () => void
  onAllocate: () => void
  onBind: () => void
  onProbe: () => void
  onGeo: () => void
}

export function VmProxyTab(props: VmProxyTabProps) {
  const { t: tVm } = useTranslation('vm')

  const {
    vm,
    proxy,
    boundId,
    free,
    bindId,
    canManage,
    busy,
    onBindIdChange,
    onUnbind,
    onAllocate,
    onBind,
    onProbe,
    onGeo,
  } = props
  const health = proxyHealthOf(vm, proxy)
  const local = !!boundId && proxyIsLocal(proxy)
  const fallbackOpts = useLocalProxyLabelOpts(vm.node_id)
  const labelOpts = localProxyOptsFromProxy(proxy, fallbackOpts)
  const localLabel = localProxyText(labelOpts)
  // 本地代理行的地理/延迟是控制面那台；节点槽从节点出网，那份探测不代表它。
  const selectedId = bindId
  const selected = free.find((p) => p.id === selectedId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [nodeQuery, setNodeQuery] = useState('')
  const q = nodeQuery.trim().toLowerCase()
  // 下拉里显示的是带节点名的标签（本地代理），裸地址匹配不到它，两边都比。
  const matched = q
    ? free.filter(
        (p) =>
          proxyMatchesQuery(p, q, () => '') ||
          proxyLabel(p, labelOpts).toLowerCase().includes(q)
      )
    : free

  return (
    <TabsContent value='proxy' className='space-y-3 pt-4'>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            {local
              ? tVm('vm:detailProxyTab.boundLocalProxy')
              : tVm('vm:detailProxyTab.boundSOCKS5')}
          </CardTitle>
        </CardHeader>
        <p className='px-6 pb-2 text-xs text-muted-foreground'>
          {local
            ? tVm(
                'vm:detailProxyTab.slotTrafficAndControlPlaneRequestsTokenExchangeRefresh',
                { localLabel: localLabel }
              )
            : tVm(
                'vm:detailProxyTab.outboundTrafficUsesThisProxySEgressGatewaySlots'
              )}
        </p>
        <CardContent className='flex flex-wrap gap-6 pt-0'>
          <HealthDonut
            score={health.score}
            label={tVm('vm:detailProxyTab.health')}
            size={80}
          />
          <div className='min-w-0 flex-1 divide-y'>
            <Field label={tVm('vm:detailProxyTab.bindingID')}>
              <span className='field-host text-xs'>{boundId || '—'}</span>
            </Field>
            {proxy.label ? (
              <Field label={tVm('vm:detailProxyTab.proxyName')}>
                <span className='text-xs'>{proxy.label}</span>
              </Field>
            ) : null}
            <Field label={tVm('vm:detailProxyTab.address')}>
              <span className='field-host text-xs'>
                {proxyHostLabel(proxy, labelOpts)}
              </span>
            </Field>
            <Field label={tVm('vm:detailAccountTab.status')}>
              <span className='flex items-center gap-2'>
                {proxyStatusLabel(proxy)}
                {vm.has_token && !proxy.host && !vm.proxy_id ? (
                  <StatusMark
                    variant='pill'
                    tone={{
                      key: 'bad',
                      text: tVm('vm:detailProxyTab.sOCKS5Missing'),
                      cls: 'bad',
                      label: tVm('vm:detailProxyTab.sOCKS5MissingFailClosed'),
                    }}
                  />
                ) : null}
              </span>
            </Field>
            <Field label={tVm('vm:detailProxyTab.latency')}>
              <span
                className={cn(
                  'field-metric text-sm',
                  proxyFieldClass(proxyLatencyTone(proxy))
                )}
              >
                {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
              </span>
            </Field>
            <Field label={tVm('vm:detailProxyTab.authentication')}>
              {proxy.has_auth
                ? tVm('vm:detailProxyTab.yes')
                : tVm('vm:detailProxyTab.none')}
            </Field>
            <Field label={tVm('vm:createExitField.egress')}>
              {proxy.geo?.country || proxy.geo?.timezone ? (
                <span className='flex flex-wrap items-center gap-1.5'>
                  {[proxy.geo.country_code || proxy.geo.country, proxy.geo.city]
                    .filter(Boolean)
                    .map((v) => (
                      <StatusMark
                        key={v}
                        variant='pill'
                        tone={{ key: 'none', text: String(v), cls: 'none' }}
                      />
                    ))}
                  {proxy.geo.timezone ? (
                    <>
                      <StatusMark
                        variant='pill'
                        tone={{
                          key: 'none',
                          text: proxy.geo.timezone,
                          cls:
                            proxy.geo.timezone !== vm.timezone
                              ? 'caution'
                              : 'none',
                        }}
                      />
                      {proxy.geo.timezone !== vm.timezone ? (
                        <span className='text-[11px] text-muted-foreground'>
                          {tVm(
                            canManage
                              ? 'vm:messages.slotTimezoneCanFollow'
                              : 'vm:messages.slotTimezone',
                            { timezone: vm.timezone || '—' }
                          )}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {proxy.geo.isp ? (
                    <span className='text-[11px] text-muted-foreground'>
                      {proxy.geo.isp}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className='text-xs text-muted-foreground'>
                  {proxy.blocked_reason
                    ? tVm('vm:detailProxyTab.iPv6Disabled')
                    : proxy.geo?.error
                      ? tVm('vm:detailProxyTab.checkFailed')
                      : tVm('vm:detailProxyTab.notChecked')}
                </span>
              )}
            </Field>
          </div>
        </CardContent>
      </Card>
      {canManage ? (
        <div className='flex flex-wrap gap-2'>
          {boundId ? (
            <>
              <Button
                size='sm'
                variant='outline'
                onClick={onProbe}
                loading={busy('proxy:probe')}
                disabled={!!proxy.blocked_reason}
              >
                <Trans ns='vm' i18nKey='detailProxyTab.checkConnection' />
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={onGeo}
                loading={busy('proxy:geo')}
                disabled={!!proxy.blocked_reason}
              >
                <Trans ns='vm' i18nKey='detailProxyTab.checkLocation' />
              </Button>
              <Button
                size='sm'
                variant='outline'
                loading={busy('proxy:unbind')}
                disabled={busy('proxy:bind')}
                onClick={onUnbind}
              >
                <Trans ns='vm' i18nKey='detailProxyTab.unbind' />
              </Button>
            </>
          ) : null}
          <Button
            size='sm'
            variant='outline'
            loading={busy('/allocate-proxy')}
            onClick={onAllocate}
          >
            <Trans ns='vm' i18nKey='detailProxyTab.assignAvailableEgress' />
          </Button>
          <Button size='sm' variant='ghost' asChild>
            <Link to='/settings/$tab' params={{ tab: 'socks5' }}>
              <Trans ns='vm' i18nKey='detailProxyTab.managePoolInSettings' />
            </Link>
          </Button>
        </div>
      ) : null}
      {!canManage ? null : free.length ? (
        <div className='flex gap-2'>
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              setPickerOpen(open)
              if (!open) setNodeQuery('')
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant='outline'
                role='combobox'
                aria-expanded={pickerOpen}
                aria-label={tVm('vm:detailProxyTab.selectEgress')}
                className='h-9 w-64 justify-between px-3 font-normal'
              >
                <span className='truncate'>
                  {selected
                    ? proxyLabel(selected, labelOpts)
                    : tVm('vm:detailProxyTab.selectEgress')}
                </span>
                <ChevronsUpDown
                  aria-hidden='true'
                  className='size-4 shrink-0 opacity-50'
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-80 p-0'>
              {/* 自己过滤：与代理页同一套子串匹配，cmdk 默认的模糊打分会把不相干的地址也排进来。 */}
              <Command shouldFilter={false}>
                <CommandInput
                  value={nodeQuery}
                  onValueChange={setNodeQuery}
                  placeholder={tVm(
                    'vm:detailProxyTab.filterAvailableNodesByNameAddressCountryOrTimezone'
                  )}
                />
                <CommandList>
                  <CommandEmpty>
                    <Trans
                      ns='vm'
                      i18nKey='detailProxyTab.noMatchingAvailableNodes'
                    />
                  </CommandEmpty>
                  {matched.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={p.id}
                      onSelect={() => {
                        onBindIdChange(p.id || '')
                        setPickerOpen(false)
                        setNodeQuery('')
                      }}
                    >
                      <span className='truncate'>
                        {proxyLabel(p, labelOpts)}
                      </span>
                      <Check
                        aria-hidden='true'
                        className={cn(
                          'ms-auto size-4 shrink-0',
                          p.id === selectedId ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button
            size='sm'
            onClick={onBind}
            loading={busy('proxy:bind')}
            disabled={
              !selectedId || selectedId === boundId || busy('proxy:unbind')
            }
          >
            <Trans ns='vm' i18nKey='detailProxyTab.bind' />
          </Button>
        </div>
      ) : (
        <p className='text-sm text-muted-foreground'>
          <Trans ns='vm' i18nKey='detailProxyTab.noAvailableEgressInThePool' />
        </p>
      )}
    </TabsContent>
  )
}

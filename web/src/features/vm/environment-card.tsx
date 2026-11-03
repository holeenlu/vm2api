import { useEffect, useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import {
  TIMEZONE_SOURCE_LABELS,
  validTimezone,
  zoneNowLabel,
} from '@/lib/timezone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/features/vm/detail-section-primitives'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type VmEnvironmentCardProps = {
  vm: Vm
  proxy: VmProxySnap
  saving: boolean
  onSave: (timezone: string) => void
  onFollowProxy: () => void
}

/**
 * 槽位环境设置。目前只有时区：kernel.json 的 timezone 热读，不必重启内核。
 * 容器进程环境变量 TZ 仍要换容器才变。
 */
export function VmEnvironmentCard({
  vm,
  proxy,
  saving,
  onSave,
  onFollowProxy,
}: VmEnvironmentCardProps) {
  const { t: tVm } = useTranslation('vm')

  const current = String(vm.timezone || '')
  const [draft, setDraft] = useState(current)
  // 槽位切换或后端回写新时区后，草稿跟随服务端值重置。
  useEffect(() => setDraft(current), [current])

  const proxyZone = validTimezone(proxy?.geo?.timezone)
  const geoText = [proxy?.geo?.country, proxy?.geo?.city]
    .filter(Boolean)
    .join(' · ')
  const dirty = draft.trim() !== current
  const valid = !!validTimezone(draft)

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>
          <Trans ns='vm' i18nKey='createVmForm.environment' />
        </CardTitle>
      </CardHeader>
      <p className='px-6 pb-2 text-xs text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='environmentCard.timezoneIsWrittenToKernelJsonAndReloadedLive'
        />
      </p>
      <CardContent className='divide-y pt-0'>
        <Field label={tVm('vm:environmentCard.currentTimezone')}>
          {current ? (
            <span className='flex items-center gap-2 text-xs'>
              <span className='field-host'>{current}</span>
              <span className='text-muted-foreground'>
                {TIMEZONE_SOURCE_LABELS[String(vm.timezone_source || 'auto')] ||
                  tVm('vm:createOptions.automatic')}
              </span>
              <span className='field-metric text-muted-foreground'>
                {zoneNowLabel(current)}
              </span>
            </span>
          ) : (
            <span className='text-sm'>
              <Trans ns='vm' i18nKey='environmentCard.timezoneNotConfigured' />
            </span>
          )}
        </Field>
        <Field label={tVm('vm:environmentCard.proxyEgress')}>
          <span className='text-xs text-muted-foreground'>
            {proxyZone
              ? `${proxyZone}${geoText ? ` · ${geoText}` : ''}`
              : tVm('vm:environmentCard.notCheckedUseLocationInTheProxyPool')}
          </span>
        </Field>
        <Field label={tVm('vm:environmentCard.setTimezone')}>
          <div className='w-full max-w-[320px] space-y-2'>
            <TimezonePicker
              value={draft}
              onChange={setDraft}
              disabled={saving}
            />
            <div className='flex flex-wrap gap-2'>
              <Button
                size='sm'
                disabled={saving || !dirty || !valid}
                loading={saving}
                onClick={() => onSave(draft.trim())}
              >
                <Trans ns='vm' i18nKey='authSchemeEditor.save' />
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={saving || !proxyZone || proxyZone === current}
                title={
                  proxyZone
                    ? tVm('vm:environmentCard.changeTo', {
                        proxyZone: proxyZone,
                      })
                    : tVm(
                        'vm:environmentCard.proxyLocationIsUnknownCheckItInTheProxy'
                      )
                }
                onClick={onFollowProxy}
              >
                <Trans ns='vm' i18nKey='environmentCard.followProxyTimezone' />
              </Button>
            </div>
            {dirty && !valid ? (
              <p className='text-xs text-[color:var(--status-bad)]'>
                <Trans ns='vm' i18nKey='environmentCard.invalidIANATimezone' />
              </p>
            ) : null}
          </div>
        </Field>
      </CardContent>
    </Card>
  )
}

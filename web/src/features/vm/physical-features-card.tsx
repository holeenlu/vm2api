import { t as tVm } from '@/i18n'
import type { Vm, VmPhysicalFeatures } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { fmtAgo, fmtBytes, fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/features/vm/detail-section-primitives'

function dash(value: unknown, empty = tVm('vm:detailOpsTab.notCollected')) {
  if (value == null) return empty
  const text = String(value).trim()
  return text ? text : empty
}

function Mono({ children }: { children: string }) {
  useTranslation('vm')

  return <span className='font-mono text-xs'>{children}</span>
}

function Fact({
  label,
  value,
  empty = tVm('vm:detailOpsTab.notCollected'),
}: {
  label: string
  value: unknown
  empty?: string
}) {
  useTranslation('vm')

  const text = dash(value, empty)
  return (
    <Field label={label}>
      {text === empty ? (
        <span className='text-muted-foreground'>{empty}</span>
      ) : (
        <Mono>{text}</Mono>
      )}
    </Field>
  )
}

function osLabel(features: VmPhysicalFeatures) {
  const pretty = dash(features.os_pretty, '')
  const id = dash(features.os_id, '')
  if (pretty && id && pretty !== id) return `${pretty} (${id})`
  return pretty || id || null
}

function memoryLabel(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return null
  return fmtBytes(bytes)
}

function observedLabel(at: string | null | undefined) {
  const abs = fmtExpiresAt(at)
  if (!at || abs === '—') return null
  const ago = fmtAgo(at)
  return ago ? `${abs} · ${ago}` : abs
}

export function VmPhysicalFeaturesCard({
  vm,
  collecting = false,
  onCollect,
}: {
  vm: Vm
  collecting?: boolean
  onCollect: () => void
}) {
  const { t: tVm } = useTranslation('vm')

  const features = vm.physical_features || {}
  const dmi = features.dmi || {}
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm'>
          <Trans ns='vm' i18nKey='physicalFeaturesCard.hardwareIdentity' />
        </CardTitle>
        <Button
          size='sm'
          variant='outline'
          className='h-7'
          loading={collecting}
          onClick={onCollect}
        >
          <Trans ns='vm' i18nKey='physicalFeaturesCard.collect' />
        </Button>
      </CardHeader>
      <CardContent className='divide-y pt-0'>
        <Fact
          label={tVm('vm:createVmForm.runtime')}
          value={features.runtime_type || vm.runtime_type}
          empty='—'
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.collectionTime')}
          value={observedLabel(features.observed_at)}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.hostname')}
          value={features.hostname}
        />
        <Fact
          label={tVm('vm:createVmForm.operatingSystem')}
          value={osLabel(features)}
        />
        <Fact
          label={tVm('vm:detailStatusBoard.kernel')}
          value={features.kernel_release}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.architecture')}
          value={features.arch}
        />
        <Fact label='CPU' value={features.cpu_model} />
        <Fact
          label={tVm('vm:physicalFeaturesCard.cores')}
          value={features.cpu_cores}
        />
        <Fact
          label={tVm('vm:createVmForm.memoryAlternative')}
          value={memoryLabel(features.memory_bytes)}
        />
        <Fact label={tVm('vm:createVmForm.disk')} value={features.root_disk} />
        <Fact label='MAC' value={features.mac} />
        <Fact
          label={tVm('vm:physicalFeaturesCard.manufacturer')}
          value={dmi.manufacturer}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.product')}
          value={dmi.product}
        />
        <Fact
          label={tVm('vm:codexKernelHealthCard.version')}
          value={dmi.version}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.family')}
          value={dmi.family}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.serialNumber')}
          value={dmi.serial}
        />
        <Fact label='UUID' value={dmi.uuid} />
        <Fact label={tVm('vm:labels.shell')} value={features.shell} />
        <Fact
          label={tVm('vm:physicalFeaturesCard.packageManager')}
          value={features.package_managers}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.toolchain')}
          value={features.runtimes}
        />
        <Fact
          label={tVm('vm:physicalFeaturesCard.timezone')}
          value={features.timezone}
        />
        <Fact label={tVm('vm:createVmForm.region')} value={features.locale} />
        <Field label='machine-id'>
          {features.machine_id_present ? (
            <Mono>{tVm('vm:detailProxyTab.yes')}</Mono>
          ) : (
            <span className='text-muted-foreground'>
              {features.observed_at
                ? tVm('vm:detailProxyTab.none')
                : tVm('vm:detailOpsTab.notCollected')}
            </span>
          )}
        </Field>
      </CardContent>
    </Card>
  )
}

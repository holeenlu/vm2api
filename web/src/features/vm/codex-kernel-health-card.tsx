import type { VmKernelHealth } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { Field } from '@/features/vm/detail-section-primitives'

export function CodexKernelHealthFields({
  health,
}: {
  health?:
    | (VmKernelHealth & {
        proxy_ok?: boolean | null
        accounts?: number | null
        vm_id?: string | null
      })
    | null
}) {
  const { t: tVm } = useTranslation('vm')

  const up = Boolean(health?.reachable)
  return (
    <>
      <Field label={tVm('vm:codexKernelHealthCard.codexKernel')} compact>
        {up
          ? tVm('vm:codexKernelHealthCard.reachable')
          : health?.error_code || tVm('vm:codexKernelHealthCard.unreachable')}
      </Field>
      <Field label={tVm('vm:codexKernelHealthCard.version')} compact>
        {health?.worker_version || '—'}
      </Field>
      <Field label='SOCKS' compact>
        {health?.proxy_ok == null
          ? '—'
          : health.proxy_ok
            ? tVm('vm:codexKernelHealthCard.configured')
            : tVm('vm:codexKernelHealthCard.missing')}
      </Field>
      <Field label={tVm('vm:codexKernelHealthCard.credentialCount')} compact>
        {health?.accounts == null ? '—' : String(health.accounts)}
      </Field>
    </>
  )
}

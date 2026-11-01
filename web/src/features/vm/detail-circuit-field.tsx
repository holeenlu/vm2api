import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { RotateCcw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { vmCircuit } from '@/lib/vm-status'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Field } from '@/features/vm/detail-section-primitives'

/** 详情状态板里的 Claude 单元熔断行：状态、连续失败次数、恢复时间、手动重置。 */
export function CircuitField({ vm, now: pageNow }: { vm: Vm; now: number }) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  // 熔断窗口通常只有几十秒，页面 30s 心跳太粗；打开期间单独按秒走。
  const open = vm.circuit?.state === 'open'
  const tick = useNow(open ? 1000 : 60_000)
  const now = open ? tick : pageNow
  const reset = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/circuit/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      toast.success(tVm('vm:detailCircuitField.circuitBreakerReset'))
      await qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      await qc.invalidateQueries({ queryKey: ['panel', 'vm', vm.id] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  if (!vm.circuit) return null
  const c = vmCircuit(vm, now)
  const failures = Number(vm.circuit.failures || 0)
  const threshold = Number(vm.circuit.threshold || 0)
  const tone = !c
    ? failures > 0
      ? 'text-[color:var(--status-caution)]'
      : 'text-muted-foreground'
    : c.state === 'open'
      ? 'text-[color:var(--status-bad)]'
      : 'text-[color:var(--status-caution)]'
  const label = !c
    ? tVm('vm:detailCircuitField.off')
    : c.state === 'open'
      ? tVm('vm:detailCircuitField.circuitOpen')
      : tVm('vm:detailCircuitField.halfOpenAwaitingProbe')
  return (
    <Field label={tVm('vm:detailCircuitField.circuitBreaker')} compact>
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className={cn('font-medium', tone)}>{label}</span>
        <span className='text-xs text-muted-foreground tabular-nums'>
          <Trans
            ns='vm'
            i18nKey='detailCircuitField.consecutive5xx'
            values={{ failures: failures, threshold: threshold }}
          />
        </span>
        {c?.state === 'open' ? (
          <span className='text-xs text-muted-foreground tabular-nums'>
            <Trans
              ns='vm'
              i18nKey='detailCircuitField.probeAllowedInS'
              values={{ value: Math.max(1, Math.ceil(c.left / 1000)) }}
            />
          </span>
        ) : null}
        {c ? (
          <Button
            size='sm'
            variant='ghost'
            className='h-6 px-1.5 text-xs'
            disabled={reset.isPending}
            onClick={() => reset.mutate()}
          >
            <Trans
              ns='vm'
              i18nKey='detailCircuitField.reset'
              components={{ part0: <RotateCcw className='size-3' /> }}
            />
          </Button>
        ) : null}
      </div>
    </Field>
  )
}

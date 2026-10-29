import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Segmented } from '@/components/choice-tiles'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  memoryRaiseOptions,
  memoryRaiseTarget,
  runtimeTypeOf,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

function configuredMemory(vm: Vm): VmMemoryOption | string {
  const raw =
    vm.machine?.memory || (vm.runtime?.memory as string | undefined) || '512m'
  return VM_MEMORY_OPTIONS.includes(raw as VmMemoryOption)
    ? (raw as VmMemoryOption)
    : String(raw)
}

function VmMemoryBlockInner({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const current = configuredMemory(vm)
  const runtimeMem =
    typeof vm.runtime?.memory === 'string' ? vm.runtime.memory : null
  const canRaise = useVmPerms().admin
  const raiseIds = memoryRaiseOptions(String(current))
  const raiseOptions = raiseIds.map((id) => ({
    value: id,
    label: VM_MEMORY_LABELS[id],
  }))

  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<VmMemoryOption | null>(null)
  const target = memoryRaiseTarget(picked, raiseIds)
  const qc = useQueryClient()

  const save = useMutation({
    mutationFn: (memory: VmMemoryOption) =>
      patchVm<{ memory_raise?: { memory?: string } }>(vm.id, {
        machine: { memory },
      }),
    onSuccess: async (data) => {
      const applied = data?.memory_raise?.memory
      toast.success(
        applied
          ? tVm('vm:vmMemoryBlock.memoryIncreasedTo', { applied: applied })
          : tVm('vm:vmMemoryBlock.memoryIncreased')
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      setOpen(false)
    },
    onError: (error: Error) =>
      toast.error(
        error.message || tVm('vm:vmMemoryBlock.failedToIncreaseMemory')
      ),
  })

  if (!raiseOptions.length || !canRaise) {
    return (
      <div className='space-y-1 rounded-md border px-2.5 py-2 text-xs'>
        <div className='font-medium'>
          <Trans ns='vm' i18nKey='createVmForm.memoryAlternative' />
        </div>
        <div className='text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='vmMemoryBlock.configured'
            values={{
              value: VM_MEMORY_LABELS[current as VmMemoryOption] || current,
              value1:
                runtimeMem && runtimeMem !== current
                  ? tVm('vm:vmMemoryBlock.container', {
                      value1:
                        VM_MEMORY_LABELS[runtimeMem as VmMemoryOption] ||
                        runtimeMem,
                    })
                  : '',
              value2: raiseOptions.length
                ? ''
                : tVm('vm:vmMemoryBlock.maximumOptionReached'),
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='min-w-0 text-xs'>
          <div className='font-medium'>
            <Trans ns='vm' i18nKey='createVmForm.memoryAlternative' />
          </div>
          <div className='text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='vmMemoryBlock.configuredAlternative'
              values={{
                value: VM_MEMORY_LABELS[current as VmMemoryOption] || current,
                value1:
                  runtimeMem && runtimeMem !== current
                    ? tVm('vm:vmMemoryBlock.container', {
                        value1:
                          VM_MEMORY_LABELS[runtimeMem as VmMemoryOption] ||
                          runtimeMem,
                      })
                    : '',
              }}
            />
          </div>
        </div>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (save.isPending) return
            if (next) setPicked(null)
            setOpen(next)
          }}
        >
          <DialogTrigger asChild>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 text-xs'
            >
              <Trans ns='vm' i18nKey='vmMemoryBlock.increase' />
            </Button>
          </DialogTrigger>
          <DialogContent className='sm:max-w-md'>
            <DialogHeader>
              <DialogTitle>
                <Trans
                  ns='vm'
                  i18nKey='vmMemoryBlock.increaseContainerMemory'
                />
              </DialogTitle>
              <DialogDescription>
                <Trans
                  ns='vm'
                  i18nKey='vmMemoryBlock.runsDockerUpdateLiveAndSavesSlotConfigurationOnly'
                />
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-2'>
              <div className='text-xs text-muted-foreground'>
                <Trans
                  ns='vm'
                  i18nKey='vmMemoryBlock.current'
                  values={{
                    value:
                      VM_MEMORY_LABELS[current as VmMemoryOption] || current,
                  }}
                />
              </div>
              <Segmented
                label={tVm('vm:vmMemoryBlock.targetMemory')}
                value={target || raiseOptions[0].value}
                onChange={(v) => setPicked(v as VmMemoryOption)}
                options={raiseOptions}
              />
            </div>
            <DialogFooter>
              <Button
                type='button'
                disabled={!target || save.isPending}
                onClick={() => target && save.mutate(target)}
              >
                {save.isPending
                  ? tVm('vm:vmMemoryBlock.applyingChanges')
                  : tVm('vm:vmMemoryBlock.confirmIncrease')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <p className={cn('text-[11px] text-muted-foreground')}>
        <Trans
          ns='vm'
          i18nKey='vmMemoryBlock.increaseOnlyMemorySwapFollowsMemoryTheContainerIs'
        />
      </p>
    </div>
  )
}

export function VmMemoryBlock({ vm }: { vm: Vm }) {
  useTranslation('vm')

  if (runtimeTypeOf(vm) !== 'docker') return null
  return <VmMemoryBlockInner vm={vm} />
}

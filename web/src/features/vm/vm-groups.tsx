import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { groupsQueryOptions } from '@/features/groups/queries'
import { patchVmGroups } from './vm-group-actions'

export function VmGroupLabels({
  vm,
  className,
}: {
  vm: Vm
  className?: string
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div className={className || 'flex flex-wrap gap-1'}>
      {vm.groups?.length ? (
        vm.groups.map((g) => (
          <Badge variant='outline' key={g.id}>
            {g.name}
            {g.status === 'active' ? '' : tVm('vm:vmGroups.disabled')}
          </Badge>
        ))
      ) : (
        <span className='text-xs text-muted-foreground'>
          <Trans ns='vm' i18nKey='listPage.ungrouped' />
        </span>
      )}
    </div>
  )
}
export function VmAssignGroupsDialog({
  vm,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  vm: Vm | null
  open: boolean
  pending?: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (ids: number[], version: number) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const q = useQuery({ ...groupsQueryOptions(), enabled: open })
  const [selected, setSelected] = useState<number[]>(
    () => vm?.groups?.map((g) => g.id) || []
  )
  const [baseVersion] = useState(vm?.groups_version || 0)
  const [search, setSearch] = useState('')
  const items = (q.data?.items || []).filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans ns='vm' i18nKey='vmGroups.assignToGroups' />
          </DialogTitle>
          <DialogDescription>
            <Trans
              ns='vm'
              i18nKey='vmGroups.selectMultipleGroupsGroupsShareThisVMSConcurrency'
              values={{ id: vm?.id }}
            />
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label={tVm('vm:vmGroups.searchGroups')}
          placeholder={tVm('vm:vmGroups.searchGroups')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {q.error ? (
          <p role='alert' className='text-destructive'>
            {q.error.message}
          </p>
        ) : null}
        <div className='max-h-72 space-y-2 overflow-auto'>
          {items.map((g) => (
            <label
              key={g.id}
              className='flex cursor-pointer items-center gap-3 rounded-md border p-3'
            >
              <input
                type='checkbox'
                checked={selected.includes(g.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, g.id]
                      : selected.filter((id) => id !== g.id)
                  )
                }
              />
              <span className='flex-1'>{g.name}</span>
              <span className='text-xs text-muted-foreground'>
                {g.platform} ·{' '}
                {g.status === 'active'
                  ? tVm('vm:vmGroups.enabled')
                  : tVm('vm:vmGroups.disabledAlternative')}
              </span>
            </label>
          ))}
        </div>
        {!q.isLoading && !q.error && !q.data?.items.length ? (
          <p className='text-sm text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='vmGroups.createAServiceGroupOnTheGroupsPageFirst'
            />
          </p>
        ) : null}
        <p className='text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='vmGroups.selectedClearingAllStopsNewUserRequests'
            values={{ length: selected.length }}
            count={selected.length}
          />
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
          </Button>
          <Button
            disabled={pending || q.isLoading || !!q.error}
            onClick={() => onConfirm(selected, baseVersion)}
          >
            {pending
              ? tVm('vm:allowedModelsCard.saving')
              : tVm('vm:vmGroups.saveGroups')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
export function VmGroupsCard({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ ids, version }: { ids: number[]; version: number }) =>
      patchVmGroups(vm, ids, version),
    onSuccess: async () => {
      setOpen(false)
      toast.success(tVm('vm:vmActionsProvider.groupAssignmentsUpdated'))
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <Trans ns='vm' i18nKey='vmDetailCard.assignedGroups' />
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <VmGroupLabels vm={vm} />
          <Button variant='outline' onClick={() => setOpen(true)}>
            <Trans ns='vm' i18nKey='vmGroups.assignToGroups' />
          </Button>
        </CardContent>
      </Card>
      <VmAssignGroupsDialog
        key={open ? 'open' : 'closed'}
        vm={vm}
        open={open}
        onOpenChange={setOpen}
        pending={mutation.isPending}
        onConfirm={(ids, version) => mutation.mutate({ ids, version })}
      />
    </>
  )
}

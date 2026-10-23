import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { groupsQueryOptions } from '@/features/groups/queries'

export function VmBatchGroups({ vms }: { vms: Vm[] }) {
  const { t: tVm } = useTranslation('vm')

  const [open, setOpen] = useState(false),
    [ids, setIds] = useState<string[]>([]),
    [groups, setGroups] = useState<number[]>([]),
    [operation, setOperation] = useState('add')
  const [vmSearch, setVmSearch] = useState(''),
    [groupSearch, setGroupSearch] = useState('')
  const [targets, setTargets] = useState<Vm[]>([])
  const q = useQuery(groupsQueryOptions()),
    qc = useQueryClient()
  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/vms/groups/batch', {
        method: 'POST',
        body: JSON.stringify({
          operation,
          group_ids: groups,
          items: targets
            .filter((v) => ids.includes(v.id))
            .map((v) => ({
              id: v.id,
              expected_version: v.groups_version || 0,
            })),
        }),
      }),
    onSuccess: async () => {
      toast.success(tVm('vm:vmBatchGroups.batchGroupAssignmentsSaved'))
      setOpen(false)
      setIds([])
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <>
      <Button
        variant='outline'
        onClick={() => {
          setTargets(vms.slice())
          setOpen(true)
        }}
      >
        <Trans ns='vm' i18nKey='vmBatchGroups.batchGroups' />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[90vh] overflow-auto'>
          <DialogHeader>
            <DialogTitle>
              <Trans ns='vm' i18nKey='vmBatchGroups.batchAssignVMGroups' />
            </DialogTitle>
          </DialogHeader>
          <select
            aria-label={tVm('vm:vmBatchGroups.batchOperation')}
            className='h-9 rounded border bg-background px-2'
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
          >
            <option value='add'>
              <Trans ns='vm' i18nKey='vmBatchGroups.addToGroups' />
            </option>
            <option value='remove'>
              <Trans ns='vm' i18nKey='vmBatchGroups.removeFromGroups' />
            </option>
            <option value='replace'>
              <Trans ns='vm' i18nKey='vmBatchGroups.replaceAllGroups' />
            </option>
          </select>
          <div>
            <p className='mb-2 text-sm font-medium'>
              <Trans ns='vm' i18nKey='vmBatchGroups.selectVMsCurrentFilter' />
            </p>
            <Button
              size='sm'
              variant='ghost'
              onClick={() =>
                setIds(
                  ids.length === targets.length ? [] : targets.map((v) => v.id)
                )
              }
            >
              <Trans ns='vm' i18nKey='vmBatchGroups.selectAllClear' />
            </Button>
            <Input
              aria-label={tVm('vm:vmBatchGroups.searchSlotsForBatchOperation')}
              placeholder={tVm('vm:detailPage.searchSlots')}
              value={vmSearch}
              onChange={(e) => setVmSearch(e.target.value)}
            />
            <div className='max-h-48 space-y-2 overflow-auto'>
              {targets
                .filter((v) =>
                  `${v.name} ${v.id}`
                    .toLowerCase()
                    .includes(vmSearch.toLowerCase())
                )
                .map((v) => (
                  <label key={v.id} className='flex gap-2'>
                    <input
                      type='checkbox'
                      checked={ids.includes(v.id)}
                      onChange={(e) =>
                        setIds(
                          e.target.checked
                            ? [...ids, v.id]
                            : ids.filter((id) => id !== v.id)
                        )
                      }
                    />
                    {v.name || v.id}{' '}
                    <span className='text-muted-foreground'>{v.id}</span>
                  </label>
                ))}
            </div>
          </div>
          <div>
            <p className='mb-2 text-sm font-medium'>
              <Trans ns='vm' i18nKey='vmBatchGroups.selectGroups' />
            </p>
            <Input
              aria-label={tVm('vm:vmBatchGroups.searchGroupsForBatchOperation')}
              placeholder={tVm('vm:listPage.searchGroups')}
              value={groupSearch}
              onChange={(e) => setGroupSearch(e.target.value)}
            />
            <div className='max-h-48 space-y-2 overflow-auto'>
              {q.data?.items
                .filter((g) =>
                  g.name.toLowerCase().includes(groupSearch.toLowerCase())
                )
                .map((g) => (
                  <label key={g.id} className='flex gap-2'>
                    <input
                      type='checkbox'
                      checked={groups.includes(g.id)}
                      onChange={(e) =>
                        setGroups(
                          e.target.checked
                            ? [...groups, g.id]
                            : groups.filter((id) => id !== g.id)
                        )
                      }
                    />
                    {g.name} · {g.platform}
                    {g.status !== 'active'
                      ? tVm('vm:vmBatchGroups.disabled')
                      : ''}
                  </label>
                ))}
            </div>
          </div>
          <p className='text-xs text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='vmBatchGroups.platformAndVersionAreValidatedForTheWholeBatch'
            />
          </p>
          <DialogFooter>
            <Button
              disabled={
                save.isPending ||
                !ids.length ||
                (operation !== 'replace' && !groups.length)
              }
              onClick={() => save.mutate()}
            >
              <Trans
                ns='vm'
                i18nKey='vmBatchGroups.saveVMs'
                values={{ length: ids.length }}
                count={ids.length}
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

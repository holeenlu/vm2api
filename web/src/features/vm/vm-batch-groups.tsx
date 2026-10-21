import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
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
      toast.success('批量分组已保存')
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
        批量分组
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[90vh] overflow-auto'>
          <DialogHeader>
            <DialogTitle>批量分配 VM 分组</DialogTitle>
          </DialogHeader>
          <select
            aria-label='批量操作'
            className='h-9 rounded border bg-background px-2'
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
          >
            <option value='add'>添加到分组</option>
            <option value='remove'>从分组移除</option>
            <option value='replace'>替换全部分组</option>
          </select>
          <div>
            <p className='mb-2 text-sm font-medium'>选择 VM（当前筛选范围）</p>
            <Button
              size='sm'
              variant='ghost'
              onClick={() =>
                setIds(
                  ids.length === targets.length ? [] : targets.map((v) => v.id)
                )
              }
            >
              全选 / 清空
            </Button>
            <Input
              aria-label='搜索批量槽位'
              placeholder='搜索槽位…'
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
            <p className='mb-2 text-sm font-medium'>选择分组</p>
            <Input
              aria-label='搜索批量分组'
              placeholder='搜索分组…'
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
                    {g.status !== 'active' ? '（停用）' : ''}
                  </label>
                ))}
            </div>
          </div>
          <p className='text-xs text-muted-foreground'>
            整批校验平台与版本；任一冲突都不保存。替换为空会停止这些 VM
            接收新的用户调用。
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
              保存 {ids.length} 台 VM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

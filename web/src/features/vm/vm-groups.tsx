import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
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
  return (
    <div className={className || 'flex flex-wrap gap-1'}>
      {vm.groups?.length ? (
        vm.groups.map((g) => (
          <Badge variant='outline' key={g.id}>
            {g.name}
            {g.status === 'active' ? '' : ' · 停用'}
          </Badge>
        ))
      ) : (
        <span className='text-xs text-muted-foreground'>未分组</span>
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
          <DialogTitle>分配给分组</DialogTitle>
          <DialogDescription>
            {vm?.id} · 可多选。分组共享本 VM
            的并发和上游额度；空槽仍需完成凭证与运行准备。
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label='搜索分组'
          placeholder='搜索分组'
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
                {g.platform} · {g.status === 'active' ? '启用' : '停用'}
              </span>
            </label>
          ))}
        </div>
        {!q.isLoading && !q.error && !q.data?.items.length ? (
          <p className='text-sm text-muted-foreground'>
            请先在“分组”页面创建服务分组。
          </p>
        ) : null}
        <p className='text-xs text-muted-foreground'>
          已选 {selected.length} 个。清空后不再接收用户新请求。
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={pending || q.isLoading || !!q.error}
            onClick={() => onConfirm(selected, baseVersion)}
          >
            {pending ? '保存中…' : '保存分组'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
export function VmGroupsCard({ vm }: { vm: Vm }) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ ids, version }: { ids: number[]; version: number }) =>
      patchVmGroups(vm, ids, version),
    onSuccess: async () => {
      setOpen(false)
      toast.success('所属分组已更新')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>所属分组</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <VmGroupLabels vm={vm} />
          <Button variant='outline' onClick={() => setOpen(true)}>
            分配给分组
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

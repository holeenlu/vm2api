import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
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

export function EndpointGroups({
  endpoint,
  onClose,
}: {
  endpoint: ApiEndpoint
  onClose: () => void
}) {
  const q = useQuery(groupsQueryOptions())
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [ids, setIds] = useState(endpoint.groups?.map((g) => g.id) || [])
  const change = useMutation({
    mutationFn: () =>
      api(`/api/panel/api-endpoints/${endpoint.id}/groups`, {
        method: 'PUT',
        body: JSON.stringify({
          group_ids: ids,
          expected_version: endpoint.groups_version || 0,
        }),
      }),
    onSuccess: async () => {
      toast.success('分组已保存')
      onClose()
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>分配给分组 · {endpoint.name}</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          上游 API 直接转发请求，不占用 VM。用户通过所属分组的 API Key
          调用；同一分组只能关联 API 或 VM 一种后端。
        </p>
        <Input
          placeholder='搜索分组…'
          aria-label='搜索上游分组'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {q.error && <p role='alert'>{q.error.message}</p>}
        <div className='max-h-72 space-y-2 overflow-auto'>
          {(q.data?.items || [])
            .filter((g) => g.name.toLowerCase().includes(search.toLowerCase()))
            .map((g) => (
              <label
                key={g.id}
                className='flex items-center gap-2 rounded border p-3 text-sm'
              >
                <input
                  type='checkbox'
                  checked={ids.includes(g.id)}
                  disabled={g.resources?.some(
                    (r) => r.resource_kind !== 'api_endpoint'
                  )}
                  onChange={(e) =>
                    setIds(
                      e.target.checked
                        ? [...ids, g.id]
                        : ids.filter((id) => id !== g.id)
                    )
                  }
                />
                {g.name}
                <span className='ml-auto text-xs text-muted-foreground'>
                  {g.resources?.some((r) => r.resource_kind !== 'api_endpoint')
                    ? '已有 VM 资源'
                    : g.platform}
                </span>
              </label>
            ))}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={change.isPending || q.isLoading || !!q.error}
            onClick={() => change.mutate()}
          >
            保存分组
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

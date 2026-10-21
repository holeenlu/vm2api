import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { EndpointDetailSheet } from '@/features/api-endpoints/endpoint-detail-sheet'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { EndpointCard } from './endpoint-card'
import { EndpointGroups } from './endpoint-groups'

export function ApiEndpointsPage() {
  const qc = useQueryClient()
  const q = useQuery(apiEndpointsQueryOptions())
  const [search, setSearch] = useState('')
  const [assign, setAssign] = useState<ApiEndpoint | null>(null)
  const items = (q.data?.items || []).filter((ep) =>
    `${ep.name} ${ep.base_url} ${ep.prefix}`
      .toLowerCase()
      .includes(search.toLowerCase())
  )
  const [creating, setCreating] = useState(false)
  const [editId, setEditId] = useState('')
  const [del, setDel] = useState<ApiEndpoint | null>(null)
  const editing = items.find((item) => item.id === editId) || null
  const stats = summarize(items)
  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiEndpointsQueryOptions().queryKey })

  const toggle = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api(`/api/panel/api-endpoints/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled }),
      }),
    onSuccess: async (_data, vars) => {
      toast.success(vars.disabled ? '已停用' : '已启用')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader
      title={VIEW_TITLES.api}
      extra={
        <Button
          onClick={() => {
            setEditId('')
            setCreating(true)
          }}
        >
          添加地址
        </Button>
      }
    >
      <Input
        className='mb-4 max-w-md'
        aria-label='搜索上游 API'
        placeholder='搜索地址、名称或前缀…'
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={
          <div className='space-y-4'>
            <div className='flex flex-wrap gap-4'>
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-4 w-24' />
              <Skeleton className='h-4 w-24' />
            </div>
            <CardGridSkeleton
              cards={6}
              className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'
            />
          </div>
        }
      >
        {items.length === 0 ? (
          <p className='rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground'>
            {search.trim() ? '没有匹配的 API 地址。' : '还没有直连上游地址。'}
          </p>
        ) : (
          <div className='space-y-4'>
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground'>
              <span>地址 {stats.count}</span>
              <span>
                {stats.ready}/{stats.total} key 可用
              </span>
              <span>停用 {stats.disabled}</span>
            </div>
            <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
              {items.map((endpoint) => (
                <EndpointCard
                  key={endpoint.id}
                  endpoint={endpoint}
                  busy={toggle.isPending}
                  onGroups={() => setAssign(endpoint)}
                  onEdit={() => {
                    setCreating(false)
                    setEditId(endpoint.id)
                  }}
                  onToggle={() =>
                    toggle.mutate({
                      id: endpoint.id,
                      disabled: !endpoint.disabled,
                    })
                  }
                  onDelete={() => setDel(endpoint)}
                />
              ))}
            </div>
          </div>
        )}
      </QueryGate>
      <EndpointDetailSheet
        open={creating || !!editing}
        endpoint={creating ? null : editing}
        presets={q.data?.presets || []}
        onOpenChange={(open) => {
          if (open) return
          setCreating(false)
          setEditId('')
        }}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={() => setDel(null)}
        title='删除 API 地址'
        desc={`会删掉「${del?.name || del?.id || ''}」下的全部上游 key 和模型。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!del) return
          api(`/api/panel/api-endpoints/${encodeURIComponent(del.id)}`, {
            method: 'DELETE',
          })
            .then(() => {
              toast.success('已删除')
              setDel(null)
              return refresh()
            })
            .catch((e: Error) => toast.error(e.message))
        }}
      />
      {assign && (
        <EndpointGroups endpoint={assign} onClose={() => setAssign(null)} />
      )}
    </PageHeader>
  )
}

function summarize(items: ApiEndpoint[]) {
  let ready = 0
  let total = 0
  let disabled = 0
  for (const item of items) {
    if (item.disabled) disabled += 1
    const keys = item.api_key_entries || []
    total += keys.length
    ready += keys.filter(
      (entry) => !entry.disabled && !entry.cooldown_until
    ).length
  }
  return { count: items.length, ready, total, disabled }
}

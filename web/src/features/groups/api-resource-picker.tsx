import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { EndpointCard } from '@/features/api-endpoints/endpoint-card'
import { EndpointDetailSheet } from '@/features/api-endpoints/endpoint-detail-sheet'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'

export function ApiResourcePicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const q = useQuery(apiEndpointsQueryOptions())
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [editId, setEditId] = useState('')
  const items = q.data?.items || []
  const editing = items.find((item) => item.id === editId) || null
  const visible = items.filter((item) =>
    `${item.name} ${item.base_url} ${item.prefix}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )

  return (
    <>
      <div className='flex items-center gap-2'>
        <Input
          aria-label='搜索 API 地址'
          placeholder='搜索地址、名称或前缀…'
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button onClick={() => setCreating(true)}>添加地址</Button>
      </div>
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<CardGridSkeleton cards={2} />}
      >
        <div className='max-h-[50svh] space-y-3 overflow-y-auto'>
          {visible.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              busy={false}
              onEdit={() => setEditId(endpoint.id)}
              selection={{
                checked: value.includes(endpoint.id),
                onChange: (checked) =>
                  onChange(
                    checked
                      ? [...value, endpoint.id]
                      : value.filter((id) => id !== endpoint.id)
                  ),
              }}
            />
          ))}
          {!visible.length && (
            <p className='rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground'>
              {items.length ? '没有匹配的 API 地址。' : '还没有直连上游地址。'}
            </p>
          )}
        </div>
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
    </>
  )
}

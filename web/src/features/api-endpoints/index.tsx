import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('apiEndpoints')

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
      toast.success(
        vars.disabled ? t('apiEndpoints:disabled') : t('apiEndpoints:enabled')
      )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader
      title={t('apiEndpoints:title')}
      extra={
        <Button
          onClick={() => {
            setEditId('')
            setCreating(true)
          }}
        >
          {t('apiEndpoints:addAddress')}
        </Button>
      }
    >
      <Input
        className='mb-4 max-w-md'
        aria-label={t('apiEndpoints:searchEndpoints')}
        placeholder={t('apiEndpoints:searchPlaceholder')}
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
            {search.trim()
              ? t('apiEndpoints:noMatches')
              : t('apiEndpoints:empty')}
          </p>
        ) : (
          <div className='space-y-4'>
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground'>
              <span>
                {t('apiEndpoints:addressCount', { count: stats.count })}
              </span>
              <span>
                {t('apiEndpoints:availableKeys', {
                  ready: stats.ready,
                  count: stats.total,
                })}
              </span>
              <span>
                {t('apiEndpoints:disabledCount', { count: stats.disabled })}
              </span>
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
        title={t('apiEndpoints:deleteAddress')}
        desc={t('apiEndpoints:deleteAddressDescription', {
          name: del?.name || del?.id || '',
        })}
        confirmText={t('apiEndpoints:delete')}
        cancelBtnText={t('apiEndpoints:cancel')}
        destructive
        handleConfirm={() => {
          if (!del) return
          api(`/api/panel/api-endpoints/${encodeURIComponent(del.id)}`, {
            method: 'DELETE',
          })
            .then(() => {
              toast.success(t('apiEndpoints:deleted'))
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

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('apiEndpoints')

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
      toast.success(t('apiEndpoints:groupsSaved'))
      onClose()
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('apiEndpoints:assignGroupsTitle', { name: endpoint.name })}
          </DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          {t('apiEndpoints:groupsDescription')}
        </p>
        <Input
          placeholder={t('apiEndpoints:searchGroupsPlaceholder')}
          aria-label={t('apiEndpoints:searchGroups')}
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
                    ? t('apiEndpoints:hasVmResources')
                    : g.platform}
                </span>
              </label>
            ))}
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            {t('apiEndpoints:cancel')}
          </Button>
          <Button
            disabled={change.isPending || q.isLoading || !!q.error}
            onClick={() => change.mutate()}
          >
            {t('apiEndpoints:saveGroups')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

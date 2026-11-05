import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { SearchSelect } from '@/components/search-select'
import {
  KEY_NUMERIC_FIELDS,
  bulkKeyPatch,
  type BulkDraft,
  type BulkField,
} from './bulk-edit'
import { KeyEditField, KeyLimitFields } from './key-limit-fields'

export function BulkEditKeysDialog({
  ids,
  groups,
  groupsLoading,
  groupsError,
  canSelectPlatform,
  onClose,
  onSaved,
}: {
  ids: string[]
  groups: { id: number; name: string }[]
  groupsLoading: boolean
  groupsError: Error | null
  canSelectPlatform: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('keys')
  const qc = useQueryClient()
  const [draft, setDraft] = useState<BulkDraft>({})
  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<{ updated: number }>('/api/panel/api-keys/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, patch }),
      }),
    onSuccess: (data) => {
      toast.success(t('bulkSaved', { count: data.updated }))
      void qc.invalidateQueries({ queryKey: panelQueryKeys.apiKeys() })
      onSaved()
    },
  })
  const set = (field: BulkField, value: string) =>
    setDraft((prev) => ({ ...prev, [field]: value }))
  const toggle = (field: BulkField, enabled: boolean) =>
    setDraft((prev) => {
      const next = { ...prev }
      if (enabled)
        next[field] =
          field === 'status' ? 'active' : field in KEY_NUMERIC_FIELDS ? '0' : ''
      else delete next[field]
      return next
    })
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !mutation.isPending && onClose()}
    >
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('bulkEdit')}</DialogTitle>
          <DialogDescription>
            {t('bulkSelected', { count: ids.length })} · {t('bulkHelp')}
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-5'
          onSubmit={(event) => {
            event.preventDefault()
            if (!Object.keys(draft).length || mutation.isPending) return
            try {
              mutation.mutate(bulkKeyPatch(draft))
            } catch {
              toast.error(t('bulkInvalid'))
            }
          }}
        >
          <fieldset disabled={mutation.isPending} className='space-y-5'>
            <KeyEditField
              label={t('serviceGroup')}
              selected={draft.group_id !== undefined}
              onToggle={(enabled) => toggle('group_id', enabled)}
            >
              <SearchSelect
                label={t('serviceGroup')}
                loading={groupsLoading}
                value={draft.group_id}
                options={[
                  ...(canSelectPlatform
                    ? [{ id: '__platform__', name: t('adminKey') }]
                    : []),
                  ...groups.map((group) => ({
                    id: String(group.id),
                    name: group.name,
                  })),
                ]}
                searchPlaceholder={t('searchServiceGroup')}
                onChange={(id) => set('group_id', id || '')}
              />
            </KeyEditField>
            {draft.group_id === '__platform__' && (
              <p className='rounded-lg border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground'>
                {t('adminKeyHelp')}
              </p>
            )}
            <KeyEditField
              label={t('status')}
              selected={draft.status !== undefined}
              onToggle={(enabled) => toggle('status', enabled)}
            >
              <select
                aria-label={t('status')}
                className='h-9 w-full rounded-md border bg-background px-3 text-sm'
                value={draft.status || 'active'}
                onChange={(event) => set('status', event.target.value)}
              >
                <option value='active'>{t('enabled')}</option>
                <option value='disabled'>{t('disabled')}</option>
              </select>
            </KeyEditField>
            <KeyLimitFields values={draft} onChange={set} onToggle={toggle} />
          </fieldset>
          {'group_id' in draft && groupsError && (
            <p role='alert' className='text-sm text-destructive'>
              {groupsError.message}
            </p>
          )}
          <p className='text-xs text-muted-foreground'>{t('bulkClearHelp')}</p>
          {mutation.error && (
            <p role='alert' className='text-sm text-destructive'>
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={mutation.isPending}
              onClick={onClose}
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                !Object.keys(draft).length ||
                ('group_id' in draft && !draft.group_id)
              }
            >
              {mutation.isPending ? t('bulkSaving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

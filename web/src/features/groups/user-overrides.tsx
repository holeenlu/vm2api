import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchSelect } from '@/components/search-select'
import { usersQueryOptions } from '@/features/users/queries'
import type { CommercialGroup } from './queries'

type Override = {
  user_id: string
  username: string
  rate_multiplier: number | null
  rpm_limit: number | null
}
export function GroupUserOverrides({
  group,
  field,
  onClose,
}: {
  group: CommercialGroup
  field: 'rate_multiplier' | 'rpm_limit'
  onClose: () => void
}) {
  const { t } = useTranslation('groups')

  const qc = useQueryClient()
  const users = useQuery(usersQueryOptions())
  const [user, setUser] = useState<string>()
  const [value, setValue] = useState('')
  const [search, setSearch] = useState('')
  const label =
    field === 'rpm_limit' ? t('groups:userRpm') : t('groups:userMultiplier')
  const defaultValue =
    field === 'rpm_limit' ? group.rpm_limit : group.rate_multiplier
  const query = useQuery({
    queryKey: ['panel', 'groups', group.id, 'overrides'],
    queryFn: () =>
      api<{ items: Override[] }>(
        `/api/panel/groups/${group.id}/user-overrides`
      ),
  })
  const change = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number | null }) =>
      api(`/api/panel/groups/${group.id}/user-overrides/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: amount }),
      }),
    onSuccess: async () => {
      toast.success(t('groups:saved'))
      setUser(undefined)
      setValue('')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const rows = (query.data?.items || []).filter(
    (r) =>
      r[field] != null &&
      r.username.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t('groups:overrideTitle', { label, name: group.name })}
          </DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          {t('groups:groupDefault', {
            value:
              field === 'rpm_limit'
                ? String(group.rpm_limit || 0) + ' RPM'
                : String(group.rate_multiplier) + '×',
          })}
          {field === 'rpm_limit'
            ? t('groups:unlimitedGroupRpm')
            : t('groups:freeMultiplier')}
          {t('groups:overrideHelp')}
        </p>
        <form
          className='flex flex-wrap items-end gap-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (user && value !== '')
              change.mutate({ id: user, amount: Number(value) })
          }}
        >
          <div className='min-w-48 flex-1 space-y-2'>
            <p className='text-sm font-medium'>{t('groups:user')}</p>
            <SearchSelect
              label={t('groups:selectUser')}
              value={user}
              loading={users.isLoading || query.isLoading}
              options={(query.isSuccess ? users.data?.items || [] : []).map(
                (u) => ({
                  id: u.id,
                  name: u.username,
                })
              )}
              searchPlaceholder={t('groups:userPlaceholder')}
              onChange={(id) => {
                setUser(id)
                const row = query.data?.items.find((r) => r.user_id === id)
                setValue(id ? String(row?.[field] ?? defaultValue ?? 0) : '')
              }}
            />
          </div>
          <div className='w-36 space-y-2'>
            <Label htmlFor='group-override-value'>
              {label}
              {field === 'rate_multiplier' ? '（×）' : ''}
            </Label>
            <Input
              id='group-override-value'
              aria-label={label}
              type='number'
              min='0'
              max={field === 'rpm_limit' ? 1000000 : 1000}
              step={field === 'rpm_limit' ? 1 : 0.01}
              value={value}
              disabled={!user}
              required
              placeholder={t('groups:selectUserFirst')}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button disabled={!user || value === '' || change.isPending}>
            {t('groups:save')}
          </Button>
        </form>
        <Input
          aria-label={t('groups:searchOverrides')}
          placeholder={t('groups:overridePlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {query.error && <p role='alert'>{query.error.message}</p>}
        <div className='max-h-80 space-y-2 overflow-auto'>
          {rows.map((row) => (
            <div
              key={row.user_id}
              className='flex items-center gap-3 rounded border p-3 text-sm'
            >
              <span className='flex-1'>{row.username}</span>
              <span>
                {row[field]}
                {field === 'rate_multiplier' ? '×' : ' RPM'}
              </span>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setUser(row.user_id)
                  setValue(String(row[field]))
                }}
              >
                {t('groups:edit')}
              </Button>
              <Button
                variant='ghost'
                size='sm'
                disabled={change.isPending}
                onClick={() => change.mutate({ id: row.user_id, amount: null })}
              >
                {t('groups:restoreDefault')}
              </Button>
            </div>
          ))}
          {!query.isLoading && !rows.length && (
            <p className='p-6 text-center text-muted-foreground'>
              {t('groups:noOverrides', { label })}
            </p>
          )}
        </div>
        <Button variant='outline' onClick={onClose}>
          {t('groups:close')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

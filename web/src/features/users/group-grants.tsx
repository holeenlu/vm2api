import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { CommercialGroup } from '@/features/groups/queries'

export type GroupGrant = {
  group_id: number
  rate_multiplier: number | null
  rpm_override?: number | null
}

export function userGroupGrantPayload(value: GroupGrant[]): GroupGrant[] {
  return value.map(({ group_id }) => ({
    group_id,
    rate_multiplier: null,
    rpm_override: null,
  }))
}

export function GroupGrants({
  groups,
  value,
  onChange,
}: {
  groups: CommercialGroup[]
  value: GroupGrant[]
  onChange: (value: GroupGrant[]) => void
}) {
  const { t } = useTranslation('users')

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = new Set(value.map((grant) => grant.group_id))
  const filtered = groups
    .filter((g) =>
      `${g.name} ${g.description || ''}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
    .sort(
      (a, b) =>
        Number(selected.has(b.id)) - Number(selected.has(a.id)) ||
        a.name.localeCompare(b.name)
    )
  const toggle = (groupId: number) =>
    onChange(
      selected.has(groupId)
        ? value.filter((grant) => grant.group_id !== groupId)
        : userGroupGrantPayload([
            ...value,
            { group_id: groupId, rate_multiplier: null, rpm_override: null },
          ])
    )
  return (
    <section
      className='space-y-3 rounded-lg border p-4'
      aria-label={t('users:groupAccess')}
    >
      <div>
        <h3 className='text-sm font-semibold'>{t('users:groupAccess')}</h3>
        <p className='mt-1 text-xs leading-5 text-muted-foreground'>
          {t('users:grantHelp')}
        </p>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            aria-label={t('users:searchGroups')}
            className='h-auto min-h-9 w-full justify-between text-left whitespace-normal'
          >
            <span className='flex min-w-0 flex-1 flex-wrap gap-1.5'>
              {value.length
                ? value.map(({ group_id }) => (
                    <Badge
                      key={group_id}
                      variant='secondary'
                      className='max-w-full text-left [overflow-wrap:anywhere] whitespace-normal'
                    >
                      {groups.find((group) => group.id === group_id)?.name ??
                        `#${group_id}`}
                    </Badge>
                  ))
                : t('users:selectGroups')}
            </span>
            <ChevronDown className='size-4 shrink-0' />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          className='w-[var(--radix-popover-trigger-width)] p-2'
        >
          <Input
            autoFocus
            aria-label={t('users:searchGroups')}
            placeholder={t('users:groupPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div
            className='mt-2 max-h-64 overflow-auto'
            role='listbox'
            aria-label={t('users:groupAccess')}
            aria-multiselectable='true'
          >
            {filtered.map((g) => {
              const checked = selected.has(g.id)
              return (
                <button
                  type='button'
                  key={g.id}
                  role='option'
                  aria-selected={checked}
                  aria-label={t('users:grantGroup', { name: g.name })}
                  className={`flex w-full items-start gap-2 rounded p-2 text-left text-sm hover:bg-accent ${checked ? 'bg-primary/10 text-primary' : ''}`}
                  onClick={() => toggle(g.id)}
                >
                  <span className='mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border'>
                    {checked && <Check className='size-3' />}
                  </span>
                  <span className='min-w-0 break-words'>
                    <span className='block font-medium'>{g.name}</span>
                    <span className='text-xs text-muted-foreground'>
                      {g.is_exclusive
                        ? t('users:exclusive')
                        : t('users:public')}
                      {g.status !== 'active' ? t('users:groupDisabled') : ''}
                    </span>
                  </span>
                </button>
              )
            })}
            {!filtered.length && (
              <p className='p-3 text-sm text-muted-foreground'>
                {groups.length
                  ? t('users:noMatchingGroups')
                  : t('users:noGroups')}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <p className='text-xs text-muted-foreground'>
        {t('users:selectedGroups', { count: value.length })}
      </p>
    </section>
  )
}

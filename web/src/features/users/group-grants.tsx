import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'
import type { CommercialGroup } from '@/features/groups/queries'

export type GroupGrant = {
  group_id: number
  rate_multiplier: number | null
  rpm_override?: number | null
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

  const [search, setSearch] = useState('')
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
      <Input
        aria-label={t('users:searchGroups')}
        placeholder={t('users:groupPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className='max-h-72 space-y-2 overflow-auto'>
        {groups
          .filter((g) => g.name.toLowerCase().includes(search.toLowerCase()))
          .map((g) => {
            const grant = value.find((v) => v.group_id === g.id)
            return (
              <div
                key={g.id}
                className={`grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] ${grant ? 'border-primary/40 bg-primary/5' : ''}`}
              >
                <label className='flex min-w-0 cursor-pointer items-center gap-3'>
                  <input
                    type='checkbox'
                    aria-label={t('users:grantGroup', { name: g.name })}
                    checked={!!grant}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [
                              ...value,
                              { group_id: g.id, rate_multiplier: null },
                            ]
                          : value.filter((v) => v.group_id !== g.id)
                      )
                    }
                  />
                  <span className='min-w-0'>
                    <span className='block text-sm font-medium break-words'>
                      {g.name}
                    </span>
                    <span className='text-xs text-muted-foreground'>
                      {t('users:groupSummary', {
                        visibility: g.is_exclusive
                          ? t('users:exclusive')
                          : t('users:public'),
                        multiplier: g.rate_multiplier ?? 1,
                      })}
                      {g.status !== 'active' ? t('users:groupDisabled') : ''}
                    </span>
                  </span>
                </label>
                <FormField className='text-xs'>
                  {t('users:userMultiplier')}
                  <Input
                    aria-label={t('users:multiplierLabel', { name: g.name })}
                    type='number'
                    min='0'
                    max='1000'
                    step='0.01'
                    disabled={!grant}
                    placeholder={String(g.rate_multiplier ?? 1)}
                    value={grant?.rate_multiplier ?? ''}
                    onChange={(e) =>
                      onChange(
                        value.map((v) =>
                          v.group_id === g.id
                            ? {
                                ...v,
                                rate_multiplier:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              }
                            : v
                        )
                      )
                    }
                  />
                </FormField>
                <FormField className='text-xs'>
                  {t('users:userRpm')}
                  <Input
                    aria-label={t('users:rpmLabel', { name: g.name })}
                    type='number'
                    min='0'
                    max='1000000'
                    step='1'
                    disabled={!grant}
                    placeholder={String(g.rpm_limit || 0)}
                    value={grant?.rpm_override ?? ''}
                    onChange={(e) =>
                      onChange(
                        value.map((v) =>
                          v.group_id === g.id
                            ? {
                                ...v,
                                rpm_override:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              }
                            : v
                        )
                      )
                    }
                  />
                </FormField>
              </div>
            )
          })}
        {!groups.length && (
          <p className='p-3 text-sm text-muted-foreground'>
            {t('users:noGroups')}
          </p>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        {t('users:selectedGroups', { count: value.length })}
      </p>
    </section>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PanelRole } from '@/types/panel-auth'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { canFilterLogUsers, filtersForRole } from '../filter-policy'
import { usageLogFilterOptionsQueryOptions } from '../queries'
import type { LogsFilterState } from '../search'
import { ActiveFiltersDisplay } from './active-filters-display'
import { IdentityFilters } from './identity-filters'
import { RequestFilters } from './request-filters'
import { StatusFilters } from './status-filters'
import { TimeFilters } from './time-filters'

/** One compact draft form for all tabs; only Query commits it to the URL. */
export function UsageLogsFilters({
  role,
  filters,
  onApply,
  onReset,
  actions,
}: {
  role: PanelRole | undefined
  filters: LogsFilterState
  onApply: (filters: LogsFilterState) => void
  onReset: () => void
  actions?: ReactNode
}) {
  const { t } = useTranslation('logs')
  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  const safeDraft = filtersForRole(draft, role)
  const options = useQuery({
    ...usageLogFilterOptionsQueryOptions(role, filters.scope),
    enabled: !!role,
  })
  const reset = () => {
    setDraft({ scope: filters.scope })
    onReset()
  }
  return (
    <form
      className='space-y-4 p-4'
      onSubmit={(event) => {
        event.preventDefault()
        onApply(filtersForRole(draft, role))
      }}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-sm font-medium'>{t('logs:filters')}</span>
        <span className='text-xs text-muted-foreground'>
          {t(
            filters.scope === 'mine' || role === 'user'
              ? 'logs:scopeOwnLogs'
              : role === 'super_admin'
                ? 'logs:scopeAllLogs'
                : 'logs:scopeManagedLogs'
          )}
        </span>
      </div>
      <div className='grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-end gap-3'>
        <IdentityFilters
          role={role}
          filters={safeDraft}
          options={options.data}
          optionsLoading={options.isLoading}
          onChange={setDraft}
        />
        <RequestFilters
          role={role}
          filters={safeDraft}
          options={options.data}
          optionsLoading={options.isLoading}
          onChange={setDraft}
        />
        <StatusFilters
          role={role}
          filters={safeDraft}
          statusCodes={options.data?.statusCodes ?? []}
          onChange={setDraft}
        />
      </div>
      <div className='flex flex-wrap items-end justify-between gap-3 border-t pt-3'>
        <TimeFilters filters={safeDraft} onChange={setDraft} />
        <div className='flex flex-wrap items-center gap-2'>
          <Button type='submit' size='sm' disabled={!role}>
            <Search className='size-4' />
            {t('logs:search')}
          </Button>
          <Button type='button' size='sm' variant='outline' onClick={reset}>
            {t('logs:reset')}
          </Button>
          {actions}
        </div>
      </div>
      {options.error ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('logs:filterOptionsFailed')}
        </p>
      ) : null}
      <ActiveFiltersDisplay
        isAdmin={canFilterLogUsers(role, filters.scope)}
        filters={filtersForRole(filters, role)}
        options={options.data}
        onRemove={(next) => {
          setDraft(next)
          onApply(next)
        }}
        onClearAll={reset}
      />
    </form>
  )
}

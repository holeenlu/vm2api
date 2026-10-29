import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Network, Server, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { usageLogFilterOptionsQueryOptions } from '../queries'
import type { LogsFilterState } from '../search'
import { ActiveFiltersDisplay } from './active-filters-display'
import { FilterSection } from './filter-section'
import { IdentityFilters } from './identity-filters'
import { QuickFiltersBar } from './quick-filters-bar'
import { RequestFilters } from './request-filters'
import { StatusFilters } from './status-filters'
import { TimeFilters } from './time-filters'

/**
 * 草稿 / 应用模型（hub `UsageLogsFilters`）：所有控件、快捷预设、chip 移除
 * 只改本地草稿，点「应用筛选」才写入 URL。
 */
export function UsageLogsFilters({
  isAdmin,
  filters,
  onApply,
  onReset,
}: {
  isAdmin: boolean
  filters: LogsFilterState
  onApply: (filters: LogsFilterState) => void
  onReset: () => void
}) {
  const { t: translate } = useTranslation('logs')

  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  const options = useQuery(usageLogFilterOptionsQueryOptions())
  const optionsLoading = options.isLoading

  const identityCount =
    (isAdmin && draft.userId ? 1 : 0) +
    (draft.keyId ? 1 : 0) +
    (isAdmin && draft.vmId ? 1 : 0) +
    (draft.sessionId ? 1 : 0)
  const requestCount =
    (draft.model ? 1 : 0) +
    (draft.mismatch ? 1 : 0) +
    (draft.endpoint ? 1 : 0) +
    (draft.protocol ? 1 : 0)
  const statusCount =
    (draft.statusCode != null || draft.excludeStatus200 ? 1 : 0) +
    ((draft.minRetry ?? 0) > 0 ? 1 : 0) +
    (draft.errorClass ? 1 : 0)

  return (
    <div className='space-y-4'>
      <QuickFiltersBar filters={draft} onChange={setDraft} />
      <ActiveFiltersDisplay
        isAdmin={isAdmin}
        filters={draft}
        options={options.data}
        onRemove={setDraft}
        onClearAll={() => {
          setDraft({})
          onReset()
        }}
      />
      <div className='grid gap-4 lg:grid-cols-2'>
        <FilterSection
          title={translate('logs:timeRange')}
          description={translate('logs:timeFiltersHint')}
          icon={Clock}
          defaultOpen
          activeCount={draft.startTime != null && draft.endTime != null ? 1 : 0}
        >
          <TimeFilters filters={draft} onChange={setDraft} />
        </FilterSection>
        <FilterSection
          title={translate('logs:identity')}
          description={
            isAdmin
              ? translate('logs:adminIdentityHint')
              : translate('logs:userIdentityHint')
          }
          icon={User}
          defaultOpen
          activeCount={identityCount}
        >
          <IdentityFilters
            isAdmin={isAdmin}
            filters={draft}
            options={options.data}
            optionsLoading={optionsLoading}
            onChange={setDraft}
          />
        </FilterSection>
        <FilterSection
          title={translate('logs:requestParameters')}
          description={translate('logs:requestFiltersHint')}
          icon={Network}
          activeCount={requestCount}
        >
          <RequestFilters
            filters={draft}
            options={options.data}
            optionsLoading={optionsLoading}
            onChange={setDraft}
          />
        </FilterSection>
        <FilterSection
          title={translate('logs:statusInformation')}
          description={translate('logs:statusFiltersHint')}
          icon={Server}
          activeCount={statusCount}
        >
          <StatusFilters
            filters={draft}
            statusCodes={options.data?.statusCodes ?? []}
            onChange={setDraft}
          />
        </FilterSection>
      </div>
      <div className='flex flex-wrap items-center gap-2 pt-2'>
        <Button type='button' onClick={() => onApply(draft)}>
          {translate('logs:applyFilters')}
        </Button>
        <Button
          type='button'
          variant='outline'
          onClick={() => {
            setDraft({})
            onReset()
          }}
        >
          {translate('logs:reset')}
        </Button>
      </div>
    </div>
  )
}

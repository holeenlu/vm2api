import { i18n } from '@/i18n'
import type { UsageLogFilterOptions } from '@/types/panel-usage-logs'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { errorClassLabel } from '@/features/logs/log-display'
import type { LogsFilterState } from '../search'
import { inclusiveEndFromExclusive } from './time-range'

type ChipKey = keyof LogsFilterState | 'time' | 'status'

function nameOf(list: { id: string; name: string }[] | undefined, id: string) {
  return list?.find((item) => item.id === id)?.name ?? id
}

export function ActiveFiltersDisplay({
  isAdmin,
  filters,
  options,
  onRemove,
  onClearAll,
}: {
  isAdmin: boolean
  filters: LogsFilterState
  options: UsageLogFilterOptions | undefined
  onRemove: (filters: LogsFilterState) => void
  onClearAll: () => void
}) {
  const { t: translate } = useTranslation('logs')

  const chips: { key: ChipKey; label: string; value: string }[] = []
  if (isAdmin && filters.userId)
    chips.push({
      key: 'userId',
      label: translate('logs:user'),
      value: nameOf(options?.users, filters.userId),
    })
  if (filters.keyId)
    chips.push({
      key: 'keyId',
      label: translate('logs:apiKey'),
      value: nameOf(options?.keys, filters.keyId),
    })
  if (isAdmin && filters.vmId)
    chips.push({
      key: 'vmId',
      label: translate('logs:provider'),
      value: nameOf(options?.vms, filters.vmId),
    })
  if (filters.sessionId)
    chips.push({
      key: 'sessionId',
      label: translate('logs:sessionId'),
      value:
        filters.sessionId.length > 12
          ? `${filters.sessionId.slice(0, 12)}...`
          : filters.sessionId,
    })
  if (filters.startTime != null && filters.endTime != null) {
    const start = new Date(filters.startTime).toLocaleDateString(
      i18n.language,
      { month: 'short', day: 'numeric' }
    )
    const end = new Date(
      inclusiveEndFromExclusive(filters.endTime)
    ).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
    chips.push({
      key: 'time',
      label: translate('logs:dateRange'),
      value: start === end ? start : `${start} - ${end}`,
    })
  }
  if (filters.model)
    chips.push({
      key: 'model',
      label: translate('logs:model'),
      value: filters.model,
    })
  if (filters.mismatch)
    chips.push({
      key: 'mismatch',
      label: translate('logs:modelMismatch'),
      value: translate('logs:enabled'),
    })
  if (filters.endpoint)
    chips.push({
      key: 'endpoint',
      label: translate('logs:endpoint'),
      value: filters.endpoint,
    })
  if (filters.protocol)
    chips.push({
      key: 'protocol',
      label: translate('logs:protocol'),
      value: filters.protocol,
    })
  if (filters.excludeStatus200)
    chips.push({
      key: 'status',
      label: translate('logs:statusCode'),
      value: '!200',
    })
  else if (filters.statusCode != null)
    chips.push({
      key: 'status',
      label: translate('logs:statusCode'),
      value: String(filters.statusCode),
    })
  if ((filters.minRetry ?? 0) > 0)
    chips.push({
      key: 'minRetry',
      label: translate('logs:minimumRetries'),
      value: `>=${filters.minRetry}`,
    })
  if (filters.errorClass)
    chips.push({
      key: 'errorClass',
      label: translate('logs:errorClass'),
      value: errorClassLabel(filters.errorClass),
    })
  if (filters.debugOnly)
    chips.push({
      key: 'debugOnly',
      label: translate('logs:debugSampling'),
      value: translate('logs:enabled'),
    })

  if (!chips.length) return null

  function remove(key: ChipKey) {
    const next = { ...filters }
    if (key === 'time') {
      next.startTime = undefined
      next.endTime = undefined
    } else if (key === 'status') {
      next.statusCode = undefined
      next.excludeStatus200 = undefined
    } else {
      next[key] = undefined
    }
    onRemove(next)
  }

  return (
    <div className='-mb-1 flex [scrollbar-width:none] flex-wrap items-center gap-2 overflow-x-auto pb-1'>
      <span className='shrink-0 text-xs font-medium text-muted-foreground'>
        {translate('logs:activeFilters')}
      </span>
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant='secondary'
          className='h-auto shrink-0 gap-1 py-1 pr-1.5 pl-2'
        >
          <span className='text-xs'>{chip.label}: </span>
          <span className='font-semibold'>{chip.value}</span>
          <button
            type='button'
            aria-label={translate('logs:removeFilter')}
            onClick={() => remove(chip.key)}
            className='ml-1 cursor-pointer rounded-full outline-none hover:bg-muted-foreground/20 focus:ring-2 focus:ring-ring/50'
          >
            <X className='h-3 w-3' />
          </button>
        </Badge>
      ))}
      {chips.length > 2 ? (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-auto shrink-0 px-2 py-1 text-xs'
          onClick={onClearAll}
        >
          {translate('logs:clearAll')}
        </Button>
      ) : null}
    </div>
  )
}

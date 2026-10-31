import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DateRangePicker,
  dateRangeValueForPreset,
  type DateRangeValue,
} from '@/components/date-range-picker'
import type { LogsFilterState } from '../search'
import {
  QUICK_PERIODS,
  dateWithClockToTimestamp,
  formatClock,
  formatDate,
  inclusiveEndFromExclusive,
  shiftDateRange,
} from './time-range'

export function TimeFilters({
  filters,
  onChange,
}: {
  filters: LogsFilterState
  onChange: (filters: LogsFilterState) => void
}) {
  const { t: translate } = useTranslation('logs')

  const startDate =
    filters.startTime != null
      ? formatDate(new Date(filters.startTime))
      : undefined
  const startClock =
    filters.startTime != null ? formatClock(filters.startTime) : undefined
  const inclusiveEnd =
    filters.endTime != null
      ? inclusiveEndFromExclusive(filters.endTime)
      : undefined
  const endDate =
    inclusiveEnd != null ? formatDate(new Date(inclusiveEnd)) : undefined
  const endClock = inclusiveEnd != null ? formatClock(inclusiveEnd) : undefined

  function handleRange(range: DateRangeValue) {
    const start =
      range.startDate &&
      dateWithClockToTimestamp(
        range.startDate,
        range.startTime ?? startClock ?? '00:00:00'
      )
    const end =
      range.endDate &&
      dateWithClockToTimestamp(
        range.endDate,
        range.endTime ?? endClock ?? '23:59:59'
      )
    if (typeof start !== 'number' || typeof end !== 'number') {
      onChange({ ...filters, startTime: undefined, endTime: undefined })
      return
    }
    onChange({ ...filters, startTime: start, endTime: end + 1000 })
  }

  return (
    <div className='space-y-3'>
      <div className='space-y-2'>
        <Label>{translate('logs:dateRange')}</Label>
        <DateRangePicker
          value={{
            startDate,
            endDate,
            startTime: startClock,
            endTime: endClock,
          }}
          disableFuture
          presets={QUICK_PERIODS.map((period) => ({
            id: period,
            label:
              period === 'today'
                ? translate('logs:today')
                : period === 'yesterday'
                  ? translate('logs:yesterday')
                  : period === 'last7days'
                    ? translate('logs:lastSevenDays')
                    : period === 'last30days'
                      ? translate('logs:lastThirtyDays')
                      : period === 'thisMonth'
                        ? translate('logs:thisMonth')
                        : translate('logs:lastMonth'),
            value: dateRangeValueForPreset(
              period === 'last7days'
                ? '7days'
                : period === 'last30days'
                  ? '30days'
                  : period
            ),
          }))}
          labels={{
            empty: translate('logs:customRange'),
            clear: translate('logs:reset'),
            previous: translate('logs:previousPeriod'),
            next: translate('logs:nextPeriod'),
          }}
          onShift={(direction) =>
            startDate &&
            endDate &&
            handleRange(
              shiftDateRange(
                { startDate, endDate },
                direction === 'previous' ? 'prev' : 'next'
              )
            )
          }
          onChange={handleRange}
        />
      </div>
      <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
        <label className='space-y-1'>
          <span className='text-xs text-muted-foreground'>
            {translate('logs:startTime')}
          </span>
          <Input
            type='time'
            step={1}
            value={startClock ?? ''}
            disabled={!startDate}
            onChange={(event) => {
              if (!startDate) return
              const next = dateWithClockToTimestamp(
                startDate,
                event.target.value || '00:00:00'
              )
              if (next != null) onChange({ ...filters, startTime: next })
            }}
          />
        </label>
        <label className='space-y-1'>
          <span className='text-xs text-muted-foreground'>
            {translate('logs:endTime')}
          </span>
          <Input
            type='time'
            step={1}
            value={endClock ?? ''}
            disabled={!endDate}
            onChange={(event) => {
              if (!endDate) return
              const next = dateWithClockToTimestamp(
                endDate,
                event.target.value || '23:59:59'
              )
              if (next != null) onChange({ ...filters, endTime: next + 1000 })
            }}
          />
        </label>
      </div>
    </div>
  )
}

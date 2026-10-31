import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import {
  DateRangePicker,
  DateRangeShiftButton,
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
        <div className='flex flex-wrap items-center gap-1'>
          <DateRangeShiftButton
            direction='previous'
            disabled={!startDate || !endDate}
            label={translate('logs:previousPeriod')}
            onClick={() =>
              startDate &&
              endDate &&
              handleRange(shiftDateRange({ startDate, endDate }, 'prev'))
            }
          />
          <DateRangePicker
            value={{
              startDate,
              endDate,
              startTime: startClock,
              endTime: endClock,
            }}
            showTime
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
                      : translate('logs:lastThirtyDays'),
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
              cancel: translate('logs:cancel'),
              confirm: translate('logs:confirm'),
              selectRange: translate('logs:customRange'),
              startTime: translate('logs:startTime'),
              endTime: translate('logs:endTime'),
            }}
            onChange={(value) => handleRange(value)}
          />
          <DateRangeShiftButton
            direction='next'
            disabled={
              !startDate || !endDate || endDate >= formatDate(new Date())
            }
            label={translate('logs:nextPeriod')}
            onClick={() =>
              startDate &&
              endDate &&
              handleRange(shiftDateRange({ startDate, endDate }, 'next'))
            }
          />
        </div>
      </div>
    </div>
  )
}

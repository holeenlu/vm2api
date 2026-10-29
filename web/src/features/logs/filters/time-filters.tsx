import { useState } from 'react'
import { i18n, t as translate } from '@/i18n'
import { enUS, zhCN, zhTW, ja } from 'date-fns/locale'
import { CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { LogsFilterState } from '../search'
import {
  QUICK_PERIODS,
  dateWithClockToTimestamp,
  detectQuickPeriod,
  formatClock,
  formatDate,
  getDateRangeForPeriod,
  inclusiveEndFromExclusive,
  parseDate,
  shiftDateRange,
  type DateRangeStrings,
  type QuickPeriod,
} from './time-range'

const PERIOD_LABELS: Record<QuickPeriod, string> = {
  get today() {
    return translate('logs:today')
  },
  get yesterday() {
    return translate('logs:yesterday')
  },
  get last7days() {
    return translate('logs:lastSevenDays')
  },
  get last30days() {
    return translate('logs:lastThirtyDays')
  },
}

function LogsDateRangePicker({
  startDate,
  endDate,
  onChange,
}: DateRangeStrings & { onChange: (range: DateRangeStrings) => void }) {
  const { t: translate } = useTranslation('logs')

  const [calendarOpen, setCalendarOpen] = useState(false)
  const hasRange = Boolean(startDate && endDate)
  const today = formatDate(new Date())
  const activePeriod = detectQuickPeriod(startDate, endDate)
  const selected: DateRange | undefined =
    startDate && endDate
      ? { from: parseDate(startDate), to: parseDate(endDate) }
      : undefined
  const label =
    !startDate || !endDate
      ? translate('logs:customRange')
      : startDate === endDate
        ? parseDate(startDate).toLocaleDateString(i18n.language)
        : translate('logs:rangeBetween', {
            p0: parseDate(startDate).toLocaleDateString(i18n.language),
            p1: parseDate(endDate).toLocaleDateString(i18n.language),
          })

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <div className='flex items-center gap-1'>
        {QUICK_PERIODS.map((period) => (
          <Button
            key={period}
            type='button'
            variant={activePeriod === period ? 'default' : 'outline'}
            size='sm'
            className='h-8'
            aria-pressed={activePeriod === period}
            onClick={() =>
              onChange(
                activePeriod === period ? {} : getDateRangeForPeriod(period)
              )
            }
          >
            {PERIOD_LABELS[period]}
          </Button>
        ))}
      </div>
      <div className='flex items-center gap-1'>
        <Button
          type='button'
          variant='outline'
          size='icon'
          className='size-8'
          disabled={!hasRange}
          title={translate('logs:previousPeriod')}
          onClick={() =>
            startDate &&
            endDate &&
            onChange(shiftDateRange({ startDate, endDate }, 'prev'))
          }
        >
          <ChevronLeft className='h-4 w-4' />
        </Button>
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant={hasRange && !activePeriod ? 'default' : 'outline'}
              size='sm'
              className={cn(
                'h-8 min-w-[200px] justify-start text-left font-normal',
                !hasRange && 'text-muted-foreground'
              )}
            >
              <CalendarIcon className='mr-2 h-4 w-4' />
              <span className='truncate'>{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-auto p-0' align='start'>
            <Calendar
              mode='range'
              locale={
                (
                  {
                    'en-US': enUS,
                    'zh-CN': zhCN,
                    'zh-TW': zhTW,
                    'ja-JP': ja,
                  } as const
                )[i18n.language as 'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP'] ??
                enUS
              }
              defaultMonth={selected?.from}
              selected={selected}
              numberOfMonths={2}
              disabled={{ after: parseDate(today) }}
              onSelect={(range) => {
                if (!range?.from) return
                const start = formatDate(range.from)
                onChange({
                  startDate: start,
                  endDate: range.to ? formatDate(range.to) : start,
                })
                if (range.to) setCalendarOpen(false)
              }}
            />
            {hasRange ? (
              <div className='border-t p-2'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='w-full'
                  onClick={() => {
                    onChange({})
                    setCalendarOpen(false)
                  }}
                >
                  {translate('logs:reset')}
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
        <Button
          type='button'
          variant='outline'
          size='icon'
          className='size-8'
          disabled={!hasRange || (endDate !== undefined && endDate >= today)}
          title={translate('logs:nextPeriod')}
          onClick={() =>
            startDate &&
            endDate &&
            onChange(shiftDateRange({ startDate, endDate }, 'next'))
          }
        >
          <ChevronRight className='h-4 w-4' />
        </Button>
      </div>
    </div>
  )
}

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

  function handleRange(range: DateRangeStrings) {
    const start =
      range.startDate &&
      dateWithClockToTimestamp(range.startDate, startClock ?? '00:00:00')
    const end =
      range.endDate &&
      dateWithClockToTimestamp(range.endDate, endClock ?? '23:59:59')
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
        <LogsDateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={handleRange}
        />
      </div>
      <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
        <div className='space-y-1'>
          <Label className='text-xs text-muted-foreground'>
            {translate('logs:startTime')}
          </Label>
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
        </div>
        <div className='space-y-1'>
          <Label className='text-xs text-muted-foreground'>
            {translate('logs:endTime')}
          </Label>
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
        </div>
      </div>
    </div>
  )
}

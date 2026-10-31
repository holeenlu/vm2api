import { useEffect, useState } from 'react'
import { endOfMonth, format, startOfMonth, subDays, subMonths } from 'date-fns'
import { t } from '@/i18n'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { systemCalendarDate, systemDate } from '@/lib/system-time'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export type DateRangeValue = {
  startDate?: string
  endDate?: string
  startTime?: string
  endTime?: string
}

export type DateRangePreset = {
  id: string
  label: string
  value: DateRangeValue
}

export type DateRangePickerLabels = {
  empty: string
  clear: string
  cancel: string
  confirm: string
  selectRange: string
}

export function dateRangeValueForPreset(
  preset:
    'today' | 'yesterday' | '7days' | '30days' | 'thisMonth' | 'lastMonth',
  now = new Date(),
  times: Pick<DateRangeValue, 'startTime' | 'endTime'> = {
    startTime: '00:00:00',
    endTime: '23:59:59',
  }
): DateRangeValue {
  const today = systemCalendarDate(now)
  let from = today
  let to = today
  switch (preset) {
    case 'yesterday':
      from = to = subDays(today, 1)
      break
    case '7days':
      from = subDays(today, 6)
      break
    case '30days':
      from = subDays(today, 29)
      break
    case 'thisMonth':
      from = startOfMonth(today)
      break
    case 'lastMonth': {
      const month = subMonths(today, 1)
      from = startOfMonth(month)
      to = endOfMonth(month)
      break
    }
  }
  return {
    startDate: format(from, 'yyyy-MM-dd'),
    endDate: format(to, 'yyyy-MM-dd'),
    ...times,
  }
}

function localDate(value?: string) {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  )
  return Number.isNaN(date.getTime()) ? undefined : date
}

function dateText(value?: string) {
  const date = localDate(value)
  return date ? format(date, 'yyyy/M/d') : ''
}

// Shared presentation from the upstream logs date range picker.
export function DateRangePicker({
  value,
  onChange,
  presets = [],
  labels,
  disableFuture = false,
  allowClear = true,
  onShift,
  className,
}: {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  presets?: DateRangePreset[]
  labels: Pick<DateRangePickerLabels, 'empty' | 'clear'> & {
    previous?: string
    next?: string
  }
  disableFuture?: boolean
  allowClear?: boolean
  onShift?: (direction: 'previous' | 'next') => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [rangeStart, setRangeStart] = useState<Date>()
  const hasRange = Boolean(value.startDate && value.endDate)
  const activePreset = presets.find(
    (preset) =>
      (preset.value.startDate || '') === (value.startDate || '') &&
      (preset.value.endDate || '') === (value.endDate || '')
  )
  const selected: DateRange | undefined = rangeStart
    ? { from: rangeStart, to: undefined }
    : hasRange
      ? { from: localDate(value.startDate), to: localDate(value.endDate) }
      : undefined
  const label = !hasRange
    ? labels.empty
    : value.startDate === value.endDate
      ? value.startDate
      : `${value.startDate} ${t('common:to')} ${value.endDate}`

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {presets.length > 0 && (
        <div className='flex flex-wrap items-center gap-1'>
          {presets.map((preset) => (
            <Button
              key={preset.id}
              type='button'
              variant={activePreset === preset ? 'default' : 'outline'}
              size='sm'
              className='h-8'
              aria-pressed={activePreset === preset}
              onClick={() =>
                onChange(
                  activePreset === preset && allowClear ? {} : preset.value
                )
              }
            >
              {preset.label}
            </Button>
          ))}
        </div>
      )}
      <div className='flex items-center gap-1'>
        {onShift && (
          <DateRangeShiftButton
            direction='previous'
            disabled={!hasRange}
            label={labels.previous}
            onClick={() => onShift('previous')}
          />
        )}
        <Popover
          open={open}
          onOpenChange={(next) => {
            setRangeStart(undefined)
            setOpen(next)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant={hasRange && !activePreset ? 'default' : 'outline'}
              size='sm'
              className={cn(
                'h-8 min-w-[200px] justify-start text-start font-normal',
                !hasRange && 'text-muted-foreground'
              )}
            >
              <CalendarIcon className='mr-2 h-4 w-4' />
              <span className='truncate'>{label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto p-0'
            align='start'
          >
            <Calendar
              today={systemCalendarDate()}
              mode='range'
              defaultMonth={localDate(value.startDate)}
              selected={selected}
              numberOfMonths={2}
              disabled={
                disableFuture ? { after: systemCalendarDate() } : undefined
              }
              onSelect={(_range, day) => {
                // Commit only a complete pair, including two clicks on one day.
                if (!rangeStart) {
                  setRangeStart(day)
                  return
                }
                const [from, to] =
                  day < rangeStart ? [day, rangeStart] : [rangeStart, day]
                onChange({
                  ...value,
                  startDate: format(from, 'yyyy-MM-dd'),
                  endDate: format(to, 'yyyy-MM-dd'),
                })
                setRangeStart(undefined)
                setOpen(false)
              }}
            />
            {hasRange && allowClear && (
              <div className='border-t p-2'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='w-full'
                  onClick={() => {
                    onChange({})
                    setRangeStart(undefined)
                    setOpen(false)
                  }}
                >
                  {labels.clear}
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        {onShift && (
          <DateRangeShiftButton
            direction='next'
            disabled={
              !hasRange || (disableFuture && value.endDate! >= systemDate())
            }
            label={labels.next}
            onClick={() => onShift('next')}
          />
        )}
      </div>
    </div>
  )
}

function DateRangeShiftButton({
  direction,
  disabled,
  onClick,
  label,
}: {
  direction: 'previous' | 'next'
  disabled?: boolean
  onClick: () => void
  label?: string
}) {
  return (
    <Button
      type='button'
      variant='outline'
      size='icon'
      className='size-8'
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {direction === 'previous' ? (
        <ChevronLeft className='size-4' />
      ) : (
        <ChevronRight className='size-4' />
      )}
    </Button>
  )
}

export function SingleDatePicker({
  value,
  onChange,
  labels,
  disableFuture = false,
  className,
}: {
  value?: string
  onChange: (value: string) => void
  labels: Pick<
    DateRangePickerLabels,
    'empty' | 'clear' | 'cancel' | 'confirm' | 'selectRange'
  >
  disableFuture?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value || '')
  useEffect(() => setDraft(value || ''), [value])
  const selected = localDate(draft)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setDraft(value || '')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          className={cn(
            'h-10 w-full justify-start gap-2 rounded-lg px-3 font-normal',
            draft &&
              'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
            className
          )}
        >
          <CalendarIcon className='size-4 shrink-0' />
          <span className='truncate'>{dateText(draft) || labels.empty}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-auto p-0'>
        <Calendar
          today={systemCalendarDate()}
          mode='single'
          numberOfMonths={2}
          defaultMonth={selected}
          selected={selected}
          disabled={disableFuture ? { after: systemCalendarDate() } : undefined}
          onSelect={(next) => setDraft(next ? format(next, 'yyyy-MM-dd') : '')}
        />
        <div className='flex items-center justify-end gap-1 border-t px-3 py-2'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => setDraft('')}
          >
            {labels.clear}
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => {
              setDraft(value || '')
              setOpen(false)
            }}
          >
            {labels.cancel}
          </Button>
          <Button
            type='button'
            size='sm'
            disabled={!draft && !value}
            onClick={() => {
              onChange(draft)
              setOpen(false)
            }}
          >
            {labels.confirm}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

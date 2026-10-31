import { useEffect, useMemo, useState } from 'react'
import { endOfMonth, format, startOfMonth, subDays, subMonths } from 'date-fns'
import { t } from '@/i18n'
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
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
  startTime: string
  endTime: string
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
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
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

export function DateRangePicker({
  value,
  onChange,
  presets = [],
  labels,
  showTime = false,
  disableFuture = false,
  className,
}: {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  presets?: DateRangePreset[]
  labels: DateRangePickerLabels
  showTime?: boolean
  disableFuture?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const selected = useMemo<DateRange | undefined>(() => {
    const from = localDate(draft.startDate)
    const to = localDate(draft.endDate)
    return from ? { from, to } : undefined
  }, [draft.startDate, draft.endDate])
  const hasRange = Boolean(draft.startDate && draft.endDate)
  const triggerText = hasRange
    ? `${dateText(draft.startDate)} ${t('common:to')} ${dateText(draft.endDate)}`
    : labels.empty

  const choose = (next: DateRangeValue) => {
    setDraft(next)
  }
  const closeWithoutSave = () => {
    setDraft(value)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setDraft(value)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          className={cn(
            'h-9 min-w-52 justify-start gap-2 rounded-lg px-3 font-normal',
            hasRange &&
              'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
            className
          )}
        >
          <CalendarIcon className='size-4 shrink-0' />
          <span className='truncate'>{triggerText}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-auto p-0'>
        <div className='flex max-w-[calc(100vw-2rem)] overflow-hidden rounded-md'>
          {presets.length ? (
            <div className='flex w-28 shrink-0 flex-col gap-1 border-e p-2'>
              {presets.map((preset) => {
                const active =
                  (preset.value.startDate || '') === (draft.startDate || '') &&
                  (preset.value.endDate || '') === (draft.endDate || '')
                return (
                  <button
                    type='button'
                    key={preset.id}
                    className={cn(
                      'rounded-md px-3 py-2 text-start text-sm transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted'
                    )}
                    onClick={() => choose(preset.value)}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className='min-w-0'>
            <Calendar
              mode='range'
              numberOfMonths={2}
              defaultMonth={selected?.from}
              selected={selected}
              disabled={disableFuture ? { after: new Date() } : undefined}
              onSelect={(next) => {
                choose({
                  ...draft,
                  startDate: next?.from ? format(next.from, 'yyyy-MM-dd') : '',
                  endDate: next?.to ? format(next.to, 'yyyy-MM-dd') : '',
                })
              }}
            />
            {showTime ? (
              <div className='flex flex-wrap items-center gap-2 border-t px-3 py-2'>
                <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                  {labels.startTime}
                  <Input
                    className='h-9 w-28'
                    type='time'
                    step={1}
                    value={draft.startTime || '00:00:00'}
                    onChange={(event) =>
                      choose({ ...draft, startTime: event.target.value })
                    }
                  />
                </label>
                <span className='text-muted-foreground'>{t('common:to')}</span>
                <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                  {labels.endTime}
                  <Input
                    className='h-9 w-28'
                    type='time'
                    step={1}
                    value={draft.endTime || '23:59:59'}
                    onChange={(event) =>
                      choose({ ...draft, endTime: event.target.value })
                    }
                  />
                </label>
              </div>
            ) : null}
            <div className='flex items-center justify-between gap-3 border-t px-3 py-2'>
              <span className='min-w-0 truncate text-xs text-muted-foreground'>
                {hasRange
                  ? `${dateText(draft.startDate)} – ${dateText(draft.endDate)}`
                  : labels.selectRange}
              </span>
              <div className='flex shrink-0 items-center gap-1'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={() => choose({})}
                >
                  {labels.clear}
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={closeWithoutSave}
                >
                  {labels.cancel}
                </Button>
                <Button
                  type='button'
                  size='sm'
                  disabled={!hasRange && !value.startDate && !value.endDate}
                  onClick={() => {
                    onChange(draft)
                    setOpen(false)
                  }}
                >
                  {labels.confirm}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DateRangeShiftButton({
  direction,
  disabled,
  onClick,
  label,
}: {
  direction: 'previous' | 'next'
  disabled?: boolean
  onClick: () => void
  label: string
}) {
  return (
    <Button
      type='button'
      variant='outline'
      size='icon'
      className='size-9'
      disabled={disabled}
      title={label}
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
          mode='single'
          numberOfMonths={2}
          defaultMonth={selected}
          selected={selected}
          disabled={disableFuture ? { after: new Date() } : undefined}
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

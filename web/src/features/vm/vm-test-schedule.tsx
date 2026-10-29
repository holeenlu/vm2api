import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as tVm, i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { Clock3, Save, Trash2 } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { validTimezone } from '@/lib/timezone'
import { isCodexVm } from '@/lib/vm-kind'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { meQueryOptions } from '@/features/auth/queries'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly'

export type TestSchedule = {
  enabled: boolean
  frequency: ScheduleFrequency
  minute?: number
  time?: string
  weekdays?: number[]
  timezone: string
  parse_error?: boolean
  model: string
  prompt: string
  max_tokens: number | null
  reasoning_effort: string | null
  last_run_at: string | null
  last_ok: boolean | null
  last_duration_ms: number | null
  last_error: string | null
  next_run_at: string | null
  running: boolean
}

export type ScheduleStructure = Pick<
  TestSchedule,
  'frequency' | 'minute' | 'time' | 'weekdays' | 'timezone'
>

type SchedulePayload = { schedule: TestSchedule | null }
type DefaultPayload = { schedule: ScheduleStructure | null }
type SyncPayload = {
  updated: string[]
  missing: string[]
  schedule: ScheduleStructure
}

type TestParams = {
  vm: Vm
  models: { id: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  onPromptChange: (value: string) => void
  onLoadSchedule: (schedule: TestSchedule) => void
}

const WEEKDAY_OPTIONS = [
  {
    value: 1,
    get label() {
      return tVm('vm:vmTestSchedule.monday')
    },
  },
  {
    value: 2,
    get label() {
      return tVm('vm:vmTestSchedule.tuesday')
    },
  },
  {
    value: 3,
    get label() {
      return tVm('vm:vmTestSchedule.wednesday')
    },
  },
  {
    value: 4,
    get label() {
      return tVm('vm:vmTestSchedule.thursday')
    },
  },
  {
    value: 5,
    get label() {
      return tVm('vm:vmTestSchedule.friday')
    },
  },
  {
    value: 6,
    get label() {
      return tVm('vm:vmTestSchedule.saturday')
    },
  },
  {
    value: 0,
    get label() {
      return tVm('vm:vmTestSchedule.sunday')
    },
  },
]

const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function localTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return validTimezone(tz) || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function defaultStructure(): ScheduleStructure {
  return { frequency: 'daily', time: '09:00', timezone: localTimezone() }
}

function formatAt(value: string | null, timezone: string) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat(i18n.language, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return value
  }
}

function structureFromSchedule(
  schedule: TestSchedule | ScheduleStructure | null
) {
  if (!schedule) return defaultStructure()
  return {
    frequency: schedule.frequency || 'daily',
    minute: schedule.minute ?? 0,
    time: schedule.time || '09:00',
    weekdays: schedule.weekdays?.length ? schedule.weekdays : [1],
    timezone: schedule.timezone || localTimezone(),
  }
}

export type FormState = {
  enabled: boolean
  structure: ScheduleStructure
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  codex: boolean
}

/**
 * A refreshed plan: unchanged → keep; form already shows it → track; form
 * untouched since the last load → adopt; user is editing → stale (warn, never overwrite).
 */
export function reconcileSchedule(
  form: FormState,
  base: TestSchedule | null,
  schedule: TestSchedule
): 'keep' | 'track' | 'adopt' | 'stale' {
  if (base && formShows(formFrom(base), schedule)) return 'keep'
  if (formShows(form, schedule)) return 'track'
  if (!base || formShows(form, base)) return 'adopt'
  return 'stale'
}

function formFrom(schedule: TestSchedule): FormState {
  return {
    enabled: schedule.enabled,
    structure: structureFromSchedule(schedule),
    model: schedule.model,
    prompt: schedule.prompt,
    maxTokens: schedule.max_tokens ?? 0,
    reasoningEffort: schedule.reasoning_effort ?? '',
    codex: schedule.reasoning_effort != null,
  }
}

/** True when the form still shows exactly this stored plan. */
function formShows(form: FormState, schedule: TestSchedule) {
  return (
    form.enabled === schedule.enabled &&
    structureEqual(form.structure, structureFromSchedule(schedule)) &&
    form.model === schedule.model &&
    form.prompt.trim() === schedule.prompt &&
    (form.codex
      ? form.reasoningEffort === schedule.reasoning_effort
      : form.maxTokens === schedule.max_tokens)
  )
}

function structureEqual(a: ScheduleStructure, b: ScheduleStructure) {
  return (
    a.frequency === b.frequency &&
    a.timezone === b.timezone &&
    (a.frequency !== 'hourly' || a.minute === b.minute) &&
    (a.frequency === 'hourly' ||
      (a.time === b.time &&
        (a.frequency !== 'weekly' ||
          JSON.stringify([...(a.weekdays || [])].sort()) ===
            JSON.stringify([...(b.weekdays || [])].sort()))))
  )
}

export function VmTestSchedule({
  vm,
  models,
  model,
  prompt,
  maxTokens,
  reasoningEffort,
  onPromptChange,
  onLoadSchedule,
}: TestParams) {
  const { t: tVm } = useTranslation('vm')

  const codex = isCodexVm(vm)
  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'super_admin'
  const queryKey = ['panel', 'vm', vm.id, 'test-schedule'] as const
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/test-schedule`
  const loaded = useRef(false)
  // The stored plan the form was last filled from; later refreshes compare against it.
  const base = useRef<TestSchedule | null>(null)
  const [stale, setStale] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [structure, setStructure] =
    useState<ScheduleStructure>(defaultStructure)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncAllOpen, setSyncAllOpen] = useState(false)
  const scheduleQuery = useQuery({
    queryKey,
    queryFn: ({ queryKey: key, signal }) =>
      api<SchedulePayload>(
        `/api/panel/vms/${encodeURIComponent(key[2])}/test-schedule`,
        { signal }
      ),
    retry: false,
    // Another tab, another admin or "sync to all" may change this plan while it is open.
    refetchInterval: 30_000,
  })
  const defaultQuery = useQuery({
    queryKey: ['panel', 'test-schedule', 'default'] as const,
    queryFn: ({ signal }) =>
      api<DefaultPayload>('/api/panel/test-schedule/default', { signal }),
    retry: false,
  })
  const saved = scheduleQuery.data?.schedule || null

  const selectedModel = model || models[0]?.id || ''
  const form: FormState = {
    enabled,
    structure,
    model: selectedModel,
    prompt,
    maxTokens,
    reasoningEffort,
    codex,
  }
  const adopt = (schedule: TestSchedule) => {
    base.current = schedule
    setStale(false)
    setEnabled(schedule.enabled)
    setStructure(structureFromSchedule(schedule))
    onLoadSchedule(schedule)
  }

  useEffect(() => {
    if (!scheduleQuery.data) return
    const schedule = scheduleQuery.data.schedule
    if (!loaded.current) {
      loaded.current = true
      if (schedule) adopt(schedule)
      else if (defaultQuery.data?.schedule) {
        setStructure(structureFromSchedule(defaultQuery.data.schedule))
      }
      return
    }
    if (!schedule) {
      base.current = null
      return
    }
    const action = reconcileSchedule(form, base.current, schedule)
    if (action === 'track') {
      base.current = schedule
      setStale(false)
    } else if (action === 'adopt') adopt(schedule)
    else if (action === 'stale') setStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on new data, not on each keystroke
  }, [defaultQuery.data?.schedule, scheduleQuery.data])

  const savedStructure = useMemo(
    () => (saved ? structureFromSchedule(saved) : null),
    [saved]
  )
  const dirty = saved
    ? enabled !== saved.enabled ||
      !savedStructure ||
      !structureEqual(structure, savedStructure) ||
      selectedModel !== saved.model ||
      prompt.trim() !== saved.prompt ||
      (codex
        ? reasoningEffort !== saved.reasoning_effort
        : maxTokens !== saved.max_tokens)
    : enabled || !structureEqual(structure, defaultStructure())

  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () =>
      api<SchedulePayload>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          ...structure,
          model: selectedModel,
          prompt,
          ...(codex
            ? { reasoning_effort: reasoningEffort }
            : { max_tokens: maxTokens }),
        }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      if (data.schedule) {
        base.current = data.schedule
        setStale(false)
        setEnabled(data.schedule.enabled)
        setStructure(structureFromSchedule(data.schedule))
        onPromptChange(data.schedule.prompt)
      }
      toast.success(
        data.schedule?.enabled
          ? tVm('vm:vmTestSchedule.scheduledTestingEnabled')
          : tVm('vm:vmTestSchedule.testScheduleSaved')
      )
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () => api<SchedulePayload>(endpoint, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      base.current = null
      setStale(false)
      setEnabled(false)
      setStructure(defaultStructure())
      toast.success(tVm('vm:vmTestSchedule.testScheduleDeleted'))
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const saveDefault = useMutation({
    mutationFn: () =>
      api<DefaultPayload>('/api/panel/test-schedule/default', {
        method: 'PUT',
        body: JSON.stringify({ schedule: structure }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['panel', 'test-schedule', 'default'], data)
      toast.success(tVm('vm:vmTestSchedule.globalDefaultScheduleTemplateSaved'))
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncSchedule = useMutation({
    mutationFn: (scope: 'ids' | 'all') =>
      api<SyncPayload>('/api/panel/test-schedule/sync', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ...(scope === 'ids' ? { vm_ids: [vm.id] } : {}),
          schedule: structure,
          // "All slots" copies the whole scheduled test, switch included.
          ...(scope === 'all'
            ? {
                test: {
                  enabled,
                  model: selectedModel,
                  prompt: prompt.trim(),
                  ...(codex
                    ? { reasoning_effort: reasoningEffort }
                    : { max_tokens: maxTokens }),
                },
              }
            : {}),
        }),
      }),
    onSuccess: (data, scope) => {
      toast.success(
        scope === 'all'
          ? tVm('vm:vmTestSchedule.scheduledTestingSyncedToSlots', {
              length: data.updated.length,
              count: data.updated.length,
            })
          : tVm('vm:vmTestSchedule.scheduleTimingOverwrittenForSlots', {
              length: data.updated.length,
              count: data.updated.length,
            })
      )
      void qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'panel' &&
          query.queryKey[1] === 'vm' &&
          query.queryKey[3] === 'test-schedule',
      })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      setSyncOpen(false)
      setSyncAllOpen(false)
    },
  })
  const busy =
    save.isPending ||
    remove.isPending ||
    saveDefault.isPending ||
    syncSchedule.isPending

  const toggleWeekday = (value: number, checked: boolean) => {
    setStructure((prev) => {
      const set = new Set(prev.weekdays || [])
      if (checked) set.add(value)
      else set.delete(value)
      const weekdays = [...set].sort((a, b) => a - b)
      return { ...prev, weekdays: weekdays.length ? weekdays : [value] }
    })
  }

  return (
    <section className='space-y-3 border-t pt-3'>
      <div className='flex items-center justify-between gap-3'>
        <h3 className='flex items-center gap-1.5 text-sm font-medium'>
          <Trans
            ns='vm'
            i18nKey='vmTestSchedule.scheduledTest'
            components={{ part0: <Clock3 className='size-4' /> }}
          />
        </h3>
        <div className='flex items-center gap-2'>
          {dirty && loaded.current ? (
            <span className='text-xs text-muted-foreground'>
              <Trans ns='vm' i18nKey='vmTestSchedule.unsaved' />
            </span>
          ) : null}
          <Switch
            aria-label={tVm('vm:vmTestSchedule.enableScheduledTesting')}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={scheduleQuery.isPending || scheduleQuery.isError || busy}
          />
        </div>
      </div>

      {stale ? (
        <div
          className='flex items-center gap-2 text-xs text-amber-600'
          role='alert'
        >
          <span>
            <Trans
              ns='vm'
              i18nKey='vmTestSchedule.thisSlotSScheduleWasChangedElsewhereSavingWill'
            />
          </span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() =>
              scheduleQuery.data?.schedule && adopt(scheduleQuery.data.schedule)
            }
          >
            <Trans ns='vm' i18nKey='vmTestSchedule.loadLatest' />
          </Button>
        </div>
      ) : null}

      {scheduleQuery.isPending ? (
        <p className='text-xs text-muted-foreground'>
          <Trans ns='vm' i18nKey='vmTestSchedule.loadingSchedule' />
        </p>
      ) : scheduleQuery.isError ? (
        <div className='flex items-center gap-2 text-xs text-destructive'>
          <span role='alert'>
            <Trans
              ns='vm'
              i18nKey='vmTestSchedule.failedToLoadSchedule'
              values={{ message: scheduleQuery.error.message }}
            />
          </span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void scheduleQuery.refetch()}
          >
            <Trans ns='vm' i18nKey='vmTestSchedule.retry' />
          </Button>
        </div>
      ) : (
        <>
          {saved?.parse_error ? (
            <p className='text-xs text-destructive' role='alert'>
              <Trans
                ns='vm'
                i18nKey='vmTestSchedule.theSavedPlanCannotBeParsedAsAStructured'
              />
            </p>
          ) : null}
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5 sm:col-span-2'>
              <Label htmlFor={`vm-test-frequency-${vm.id}`}>
                <Trans ns='vm' i18nKey='vmTestSchedule.frequency' />
              </Label>
              <Select
                value={structure.frequency}
                onValueChange={(value: ScheduleFrequency) =>
                  setStructure((prev) => ({
                    ...prev,
                    frequency: value,
                    minute: prev.minute ?? 0,
                    time: prev.time || '09:00',
                    weekdays: prev.weekdays?.length ? prev.weekdays : [1],
                  }))
                }
              >
                <SelectTrigger id={`vm-test-frequency-${vm.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='hourly'>
                    <Trans ns='vm' i18nKey='vmTestSchedule.hourly' />
                  </SelectItem>
                  <SelectItem value='daily'>
                    <Trans ns='vm' i18nKey='vmScheduling.everyDayAlternative' />
                  </SelectItem>
                  <SelectItem value='weekly'>
                    <Trans ns='vm' i18nKey='vmTestSchedule.weekly' />
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {structure.frequency === 'hourly' ? (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-minute-${vm.id}`}>
                  <Trans ns='vm' i18nKey='vmTestSchedule.minute' />
                </Label>
                <Select
                  value={String(structure.minute ?? 0)}
                  onValueChange={(value) =>
                    setStructure((prev) => ({ ...prev, minute: Number(value) }))
                  }
                >
                  <SelectTrigger id={`vm-test-minute-${vm.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className='max-h-60'>
                    {MINUTES.map((minute) => (
                      <SelectItem key={minute} value={String(minute)}>
                        {minute === 0
                          ? tVm('vm:vmTestSchedule.onTheHour0')
                          : String(minute)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-time-${vm.id}`}>
                  <Trans ns='vm' i18nKey='vmTestSchedule.timeOfDay' />
                </Label>
                <Input
                  id={`vm-test-time-${vm.id}`}
                  type='time'
                  value={structure.time || '09:00'}
                  onChange={(event) =>
                    setStructure((prev) => ({
                      ...prev,
                      time: event.target.value,
                    }))
                  }
                />
              </div>
            )}

            <div className='space-y-1.5'>
              <Label>
                <Trans ns='vm' i18nKey='physicalFeaturesCard.timezone' />
              </Label>
              <TimezonePicker
                value={structure.timezone}
                onChange={(timezone) =>
                  setStructure((prev) => ({ ...prev, timezone }))
                }
                className='w-full'
              />
              <p className='text-xs text-muted-foreground'>
                <Trans
                  ns='vm'
                  i18nKey='vmTestSchedule.currentRealRequestsConsumeQuota'
                  values={{ timezone: structure.timezone }}
                />
              </p>
            </div>

            {structure.frequency === 'weekly' ? (
              <div className='space-y-2 sm:col-span-2'>
                <Label>
                  <Trans ns='vm' i18nKey='vmTestSchedule.daysOfWeek' />
                </Label>
                <div className='flex flex-wrap gap-3'>
                  {WEEKDAY_OPTIONS.map((day) => {
                    const checked = (structure.weekdays || []).includes(
                      day.value
                    )
                    return (
                      <label
                        key={day.value}
                        className='flex items-center gap-2 text-sm'
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            toggleWeekday(day.value, next === true)
                          }
                        />
                        {day.label}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              onClick={() => save.mutate()}
              disabled={
                busy ||
                !selectedModel ||
                !prompt.trim() ||
                (structure.frequency === 'weekly' &&
                  !(structure.weekdays || []).length)
              }
              loading={save.isPending}
            >
              <Trans
                ns='vm'
                i18nKey='vmTestSchedule.saveSchedule'
                components={{ part0: <Save /> }}
              />
            </Button>
            {saved ? (
              <Button
                size='icon'
                variant='ghost'
                className='size-8 text-muted-foreground'
                aria-label={tVm('vm:vmTestSchedule.deleteScheduledTest')}
                title={tVm('vm:vmTestSchedule.deleteScheduledTest')}
                onClick={() => remove.mutate()}
                disabled={busy}
              >
                <Trash2 />
              </Button>
            ) : null}
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => setSyncOpen(true)}
            >
              <Trans ns='vm' i18nKey='vmTestSchedule.syncToThisSlot' />
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={busy || !selectedModel || !prompt.trim()}
              onClick={() => setSyncAllOpen(true)}
            >
              <Trans ns='vm' i18nKey='vmTestSchedule.syncToAllSlots' />
            </Button>
            {isAdmin ? (
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => saveDefault.mutate()}
                loading={saveDefault.isPending}
              >
                <Trans ns='vm' i18nKey='vmTestSchedule.saveAsGlobalDefault' />
              </Button>
            ) : null}
          </div>

          {saved ? (
            <div className='space-y-1 text-xs text-muted-foreground'>
              <p>
                <Trans
                  ns='vm'
                  i18nKey='vmTestSchedule.currentSchedule'
                  values={{
                    value: saved.enabled
                      ? tVm('vm:vmGroups.enabled')
                      : tVm('vm:vmTestSchedule.paused'),
                    model: saved.model,
                    value1: saved.running
                      ? tVm('vm:vmTestSchedule.running')
                      : '',
                  }}
                />
              </p>
              <p>
                <Trans
                  ns='vm'
                  i18nKey='vmTestSchedule.nextRun'
                  values={{
                    formatAt: formatAt(saved.next_run_at, saved.timezone),
                  }}
                />
              </p>
              <p>
                <Trans
                  ns='vm'
                  i18nKey='vmTestSchedule.lastRun'
                  values={{
                    formatAt: formatAt(saved.last_run_at, saved.timezone),
                    value:
                      saved.last_ok != null
                        ? tVm('vm:vmTestSchedule.summary', {
                            value1: saved.last_ok
                              ? tVm('vm:testChatResultCard.succeeded')
                              : tVm('vm:officialCcCard.failed'),
                          })
                        : '',
                    value1:
                      saved.last_duration_ms != null
                        ? ` · ${saved.last_duration_ms}ms`
                        : '',
                  }}
                />
              </p>
              {saved.last_error ? (
                <p className='break-words text-destructive'>
                  {saved.last_error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>
              <Trans ns='vm' i18nKey='vmTestSchedule.noScheduleCreatedYet' />
            </p>
          )}
        </>
      )}

      <AlertDialog open={syncOpen} onOpenChange={setSyncOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans ns='vm' i18nKey='vmTestSchedule.syncScheduleTiming' />
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tVm(
                saved
                  ? 'vm:messages.syncTiming'
                  : 'vm:messages.syncTimingCreate'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('ids')
              }}
            >
              <Trans ns='vm' i18nKey='vmTestSchedule.overwrite' />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncAllOpen} onOpenChange={setSyncAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans
                ns='vm'
                i18nKey='vmTestSchedule.syncToAllSlotsAlternative'
              />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                ns='vm'
                i18nKey='vmTestSchedule.overwriteAllSlotsYouCanManageWithThisSlot'
                values={{
                  value: enabled
                    ? tVm('vm:vmGroups.enabled')
                    : tVm('vm:vmTestSchedule.paused'),
                  value1: codex
                    ? 'effort'
                    : tVm('vm:vmTestSchedule.tokenLimit'),
                }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('all')
              }}
            >
              <Trans ns='vm' i18nKey='vmTestSchedule.overwriteAll' />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

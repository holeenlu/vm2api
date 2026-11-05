import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { groupsQueryOptions } from '@/features/groups/queries'
import {
  bulkBase,
  bulkComplete,
  bulkFields,
  appliesTo,
  groupResult,
  saveBulk,
  storePendingBulk,
  type BulkField,
  type BulkPatch,
  type BulkReport,
  type BulkRequest,
  type BulkTarget,
  type BulkValue,
} from './vm-bulk-model'

const ranges: Partial<Record<BulkField, [number, number]>> = {
  max_concurrency: [1, 256],
  max_rpm: [0, 1000000],
  weight: [1, 100],
  schedule_level: [1, 10],
}
const selectClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm'
type GroupOption = {
  id: number
  name: string
  platform: string
  status: string
}
export function VmBulkEdit({
  ids,
  onClose,
  onSaved,
  resume,
  onReturnFocus,
}: {
  ids: string[]
  onReturnFocus?: () => void
  resume?: BulkRequest | null
  onClose: () => void
  onSaved: (ids: string[]) => void
}) {
  const { t } = useTranslation('vm')
  const qc = useQueryClient()
  const [targets, setTargets] = useState<BulkTarget[]>(resume?.items || [])
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(resume ? t('vmBulk.resumeHelp') : '')
  const [scope, setScope] = useState('all')
  const [enabled, setEnabled] = useState<Partial<Record<BulkField, boolean>>>(
    Object.fromEntries(
      bulkFields.map((f) => [
        f,
        !!resume && Object.prototype.hasOwnProperty.call(resume.patch, f),
      ])
    )
  )
  const [values, setValues] = useState<Partial<Record<BulkField, string>>>(
    Object.fromEntries(
      bulkFields
        .filter(
          (f) => resume && Object.prototype.hasOwnProperty.call(resume.patch, f)
        )
        .map((f) => [
          f,
          resume!.patch[f] === null ? 'inherit' : String(resume!.patch[f]),
        ])
    )
  )
  const [groupEnabled, setGroupEnabled] = useState(!!resume?.patch.groups)
  const [mode, setMode] = useState<'add' | 'remove' | 'replace'>(
    resume?.patch.groups?.operation || 'add'
  )
  const [groupIds, setGroupIds] = useState<number[]>(
    resume?.patch.groups?.ids || []
  )
  const [search, setSearch] = useState('')
  const [ack, setAck] = useState(resume?.confirm_empty_groups || false)
  const [request, setRequest] = useState<BulkRequest | null>(resume || null)
  const [report, setReport] = useState<BulkReport | null>(null)
  const [discard, setDiscard] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api<{ items: BulkTarget[] }>(`${bulkBase}/snapshot`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
      qc.fetchQuery(groupsQueryOptions()),
    ])
      .then(([snapshot, groupData]) => {
        if (cancelled) return
        setTargets(snapshot.items)
        setGroups(groupData.items)
        setError(resume ? t('vmBulk.resumeHelp') : '')
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ids, qc, revision, resume, t])
  const scoped = targets.filter((x) => scope === 'all' || x.platform === scope)
  const mixed = new Set(scoped.map((x) => x.platform)).size > 1
  const compatible = (g: GroupOption) =>
    !mixed &&
    scoped.length > 0 &&
    [
      'mixed',
      scoped[0].platform,
      scoped[0].platform === 'anthropic' ? 'claude' : 'openai',
    ].includes(g.platform)
  const changed = groupEnabled || bulkFields.some((f) => enabled[f])
  const clearsGroups =
    groupEnabled &&
    !mixed &&
    scoped.some(
      (x) =>
        x.group_ids.length > 0 &&
        groupResult(x.group_ids, groupIds, mode).length === 0
    )
  const locked = busy || request !== null
  const close = () => {
    if (busy) return
    if (changed || request) setDiscard(true)
    else onClose()
  }
  const initial = (f: BulkField): string => {
    const v = scoped.filter((x) => appliesTo(f, x)).map((x) => x.values[f])
    if (!v.length || v.some((x) => x !== v[0])) return ''
    return v[0] === null ? 'inherit' : String(v[0])
  }
  const valueOf = (f: BulkField) => values[f] ?? initial(f)
  async function finish(result: BulkReport, command: BulkRequest) {
    setReport(result)
    if (!bulkComplete(result)) {
      setError(result.error?.message || t('vmBulk.partial'))
      return
    }
    storePendingBulk(null)
    onSaved(command.items.map((x) => x.id))
    toast.success(t('vmBulk.saved', { count: command.items.length }))
    // Persistence succeeded. Refresh failures must never become a write retry.
    try {
      await qc.invalidateQueries(
        { queryKey: panelQueryKeys.root() },
        { throwOnError: true }
      )
    } catch {
      toast.error(t('vmBulk.refreshFailed'))
    }
  }
  async function save() {
    setError('')
    setBusy(true)
    try {
      let command = request
      if (!command) {
        const patch: BulkPatch = {}
        for (const field of bulkFields) {
          if (!enabled[field] || !scoped.some((x) => appliesTo(field, x)))
            continue
          const text = valueOf(field)
          if (!text)
            throw new Error(
              t('vmBulk.valueRequired', { field: t(`vmBulk.${field}`) })
            )
          const value: BulkValue =
            text === 'inherit'
              ? null
              : field === 'schedulable'
                ? text === 'true'
                : Number(text)
          const range = ranges[field]
          if (
            range &&
            value !== null &&
            (!Number.isInteger(value) ||
              Number(value) < range[0] ||
              Number(value) > range[1])
          )
            throw new Error(
              t('vmBulk.rangeError', {
                field: t(`vmBulk.${field}`),
                min: range[0],
                max: range[1],
              })
            )
          patch[field] = value
        }
        if (groupEnabled) {
          if (
            mixed ||
            groupIds.some(
              (id) => !groups.some((g) => g.id === id && compatible(g))
            )
          )
            throw new Error(t('vmBulk.platformGroups'))
          if (mode !== 'replace' && !groupIds.length)
            throw new Error(t('vmBulk.groupRequired'))
          if (clearsGroups && !ack) throw new Error(t('vmBulk.confirmEmpty'))
          patch.groups = { operation: mode, ids: groupIds }
        }
        if (!scoped.length || !Object.keys(patch).length)
          throw new Error(t('vmBulk.noChanges'))
        command = {
          operation_id: crypto.randomUUID(),
          items: scoped,
          patch,
          confirm_empty_groups: ack,
        }
        storePendingBulk(command)
        setRequest(command)
      }
      await finish(await saveBulk(command), command)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('vmBulk.failed'))
    } finally {
      setBusy(false)
    }
  }
  async function checkOrReload() {
    if (!request) {
      setRevision((x) => x + 1)
      return
    }
    setBusy(true)
    try {
      const found = await api<BulkReport>(
        `${bulkBase}/operations/${request.operation_id}`
      )
      await finish(found, request)
    } catch (e) {
      if (e && typeof e === 'object' && 'status' in e && e.status === 404) {
        // The server rejected the batch before any write. A fresh snapshot is safe.
        storePendingBulk(null)
        setRequest(null)
        setReport(null)
        setRevision((x) => x + 1)
      } else setError(e instanceof Error ? e.message : t('vmBulk.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onReturnFocus?.()
        }}
        className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl'
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('vmBulk.title')}</DialogTitle>
          <DialogDescription>
            {t('vmBulk.description', { count: ids.length })}
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-wrap gap-2'>
          {['all', 'openai', 'anthropic'].map((p) => (
            <Button
              key={p}
              variant={scope === p ? 'default' : 'outline'}
              size='sm'
              disabled={
                locked ||
                loading ||
                !targets.some((x) => p === 'all' || x.platform === p)
              }
              onClick={() => {
                setScope(p)
                setGroupIds([])
                setAck(false)
              }}
            >
              {t(`vmBulk.scope_${p}`)}
            </Button>
          ))}
        </div>
        {loading ? (
          <p role='status'>{t('vmBulk.loading')}</p>
        ) : (
          <fieldset disabled={locked} className='min-w-0 space-y-4'>
            {bulkFields.map((field) => {
              const matching = scoped.filter((x) => appliesTo(field, x))
              const current = [
                ...new Set(
                  matching.map((x) =>
                    x.values[field] === null
                      ? t('vmBulk.defaultValue')
                      : field === 'schedulable'
                        ? t(
                            x.values[field]
                              ? 'vmBulk.enabledValue'
                              : 'vmBulk.disabledValue'
                          )
                        : String(x.values[field])
                  )
                ),
              ].join(' / ')
              const value = valueOf(field),
                range = ranges[field]
              return (
                <div key={field} className='space-y-2 border-b pb-4'>
                  <label className='flex items-center gap-2 text-sm font-medium'>
                    <input
                      type='checkbox'
                      checked={!!enabled[field]}
                      disabled={!matching.length}
                      onChange={(e) =>
                        setEnabled((v) => ({ ...v, [field]: e.target.checked }))
                      }
                    />
                    {t(`vmBulk.${field}`)}
                    <span className='text-xs font-normal text-muted-foreground'>
                      {t('vmBulk.applies', { count: matching.length })}
                    </span>
                  </label>
                  <p className='text-xs text-muted-foreground'>
                    {t('vmBulk.current', { value: current || '—' })}
                  </p>
                  <fieldset
                    disabled={!enabled[field] || !matching.length}
                    className='grid grid-cols-[minmax(0,1fr)_100px] gap-2'
                  >
                    <select
                      className={selectClass}
                      aria-label={t(`vmBulk.${field}`)}
                      value={
                        field === 'schedulable'
                          ? value
                          : value === 'inherit'
                            ? 'inherit'
                            : 'set'
                      }
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [field]:
                            e.target.value === 'set' ? '' : e.target.value,
                        }))
                      }
                    >
                      {field === 'schedulable' ? (
                        <>
                          <option value=''>{t('vmBulk.choose')}</option>
                          <option value='true'>{t('vmBulk.enable')}</option>
                          <option value='false'>{t('vmBulk.disable')}</option>
                        </>
                      ) : (
                        <>
                          <option value='set'>{t('vmBulk.set')}</option>
                          <option value='inherit'>{t('vmBulk.inherit')}</option>
                        </>
                      )}
                    </select>
                    {range && value !== 'inherit' ? (
                      <Input
                        type='number'
                        min={range[0]}
                        max={range[1]}
                        step={1}
                        aria-label={t('vmBulk.numericValue', {
                          field: t(`vmBulk.${field}`),
                        })}
                        value={value}
                        placeholder={t('vmBulk.mixed')}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [field]: e.target.value }))
                        }
                      />
                    ) : null}
                  </fieldset>
                </div>
              )
            })}
            <p className='text-xs text-muted-foreground'>
              {t('vmBulk.scheduleHelp')}
            </p>
            <div className='space-y-3 border-t pt-4'>
              <label className='flex items-center gap-2 text-sm font-medium'>
                <input
                  type='checkbox'
                  checked={groupEnabled}
                  onChange={(e) => {
                    setGroupEnabled(e.target.checked)
                    setAck(false)
                  }}
                />
                {t('vmBulk.editGroups')}
              </label>
              <fieldset disabled={!groupEnabled} className='space-y-3'>
                <select
                  className={selectClass}
                  aria-label={t('vmBulk.groupOperation')}
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as typeof mode)
                    setAck(false)
                  }}
                >
                  {(['add', 'remove', 'replace'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`vmBulk.${m}`)}
                    </option>
                  ))}
                </select>
                <Input
                  type='search'
                  value={search}
                  placeholder={t('vmBulk.searchGroups')}
                  aria-label={t('vmBulk.searchGroups')}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className='grid gap-2 sm:grid-cols-2'>
                  {groups
                    .filter((g) =>
                      g.name.toLowerCase().includes(search.toLowerCase())
                    )
                    .map((g) => (
                      <label
                        key={g.id}
                        className='flex items-center gap-2 rounded-md border p-3 text-sm'
                      >
                        <input
                          type='checkbox'
                          disabled={!compatible(g)}
                          checked={groupIds.includes(g.id)}
                          onChange={(e) => {
                            setGroupIds((v) =>
                              e.target.checked
                                ? [...v, g.id]
                                : v.filter((id) => id !== g.id)
                            )
                            setAck(false)
                          }}
                        />
                        <span className='min-w-0 break-words'>
                          {g.name}
                          <span className='block text-xs text-muted-foreground'>
                            {g.platform} ·{' '}
                            {t('vmBulk.members', {
                              count: scoped.filter((x) =>
                                x.group_ids.includes(g.id)
                              ).length,
                              total: scoped.length,
                            })}
                            {g.status !== 'active'
                              ? ` · ${t('vmBulk.inactive')}`
                              : ''}
                          </span>
                        </span>
                      </label>
                    ))}
                </div>
                {mixed ? (
                  <p className='text-sm text-amber-600 dark:text-amber-400'>
                    {t('vmBulk.platformGroups')}
                  </p>
                ) : null}
              </fieldset>
            </div>
            {clearsGroups ? (
              <label className='flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400'>
                <input
                  type='checkbox'
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                {t('vmBulk.confirmEmpty')}
              </label>
            ) : null}
          </fieldset>
        )}
        {error ? (
          <div
            role='alert'
            className='space-y-2 rounded-md border border-destructive/40 p-3 text-sm'
          >
            <p>{error}</p>
            {report?.items.map((item) => (
              <div key={item.id}>
                {item.id}:{' '}
                {Object.entries(item.fields)
                  .map(
                    ([field, cell]) =>
                      `${t(`vmBulk.${field}`)}: ${t(`vmBulk.status_${cell.status}`)}`
                  )
                  .join(' · ')}
              </div>
            ))}
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={() => void checkOrReload()}
            >
              {request ? t('vmBulk.checkStatus') : t('vmBulk.reload')}
            </Button>
            {request && report ? (
              <Button
                variant='outline'
                size='sm'
                disabled={busy}
                onClick={() => {
                  storePendingBulk(null)
                  setRequest(null)
                  setReport(null)
                  setRevision((x) => x + 1)
                }}
              >
                {t('vmBulk.editCurrent')}
              </Button>
            ) : null}
            {request ? (
              <p className='text-xs text-muted-foreground'>
                {t('vmBulk.retryHelp')}
              </p>
            ) : null}
          </div>
        ) : null}
        {discard ? (
          <div
            role='alert'
            className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm'
          >
            <span>
              {t(request ? 'vmBulk.closeUncertain' : 'vmBulk.discard')}
            </span>
            <Button variant='outline' onClick={() => setDiscard(false)}>
              {t('vmBulk.keepEditing')}
            </Button>
            <Button variant='destructive' onClick={onClose}>
              {t('vmBulk.close')}
            </Button>
          </div>
        ) : null}
        <DialogFooter className='items-center'>
          <span className='me-auto text-xs text-muted-foreground'>
            {t('vmBulk.keepUnchanged', { count: scoped.length })}
          </span>
          <Button variant='outline' disabled={busy} onClick={close}>
            {t('vmBulk.cancel')}
          </Button>
          <Button
            disabled={
              loading ||
              busy ||
              !targets.length ||
              (!changed && !request) ||
              (clearsGroups && !ack)
            }
            onClick={() => void save()}
          >
            {busy
              ? t('vmBulk.saving')
              : request
                ? t('vmBulk.retry')
                : t('vmBulk.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

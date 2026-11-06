import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { QueryGate } from '@/components/query-gate'
import { exportGatewayAccounts } from './account-transfer'
import {
  accountBase,
  type GatewayAccount,
  type GatewayCatalog,
  type ModelAccess,
} from './accounts-model'
import { bpsBulkPatch, emptyBpsBulk, type BpsBulkValue } from './bps-bulk'
import { BpsBulkFields } from './bps-bulk-fields'
import { ModelAccessField } from './model-access-field'

type Field =
  | 'status'
  | 'max_concurrency'
  | 'max_rpm'
  | 'weight'
  | 'model_access'
  | 'proxy'
  | 'notes'
  | 'bps'
type GroupMode = 'add' | 'remove' | 'replace'
type BulkResult = {
  updated: number
  items: {
    id: string
    ok: boolean
    error?: { message?: string }
  }[]
}
const selectClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm'

/** Same fields as the single-account editor (name is per account, so excluded). */
export function GatewayAccountBulkEdit({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: GatewayAccount[]
  onClose: () => void
  onSaved: (ids: string[]) => Promise<unknown>
}) {
  const { t } = useTranslation(['common', 'vm', 'vendor'])
  const catalog = useQuery({
    queryKey: ['gateway-account-catalog'],
    queryFn: () => api<GatewayCatalog>(`${accountBase}/catalog`),
  })
  const [enabled, setEnabled] = useState<Partial<Record<Field, boolean>>>({})
  // 选中账号取值一致时直接预填当前值，不一致时留空并在字段下方列出各值
  const [status, setStatus] = useState<'' | 'active' | 'paused'>(
    sameValue(
      accounts.map((a) => (a.status === 'active' ? 'active' : 'paused'))
    ) as '' | 'active' | 'paused'
  )
  const [concurrency, setConcurrency] = useState(
    sameValue(accounts.map((a) => a.config.max_concurrency))
  )
  const [rpm, setRpm] = useState(
    sameValue(accounts.map((a) => a.config.max_rpm))
  )
  const [weight, setWeight] = useState(
    sameValue(accounts.map((a) => a.config.weight ?? 1))
  )
  const [modelAccess, setModelAccess] = useState<ModelAccess>(() => {
    const same = sameValue(
      accounts.map((a) => JSON.stringify(a.config.model_access || null))
    )
    const parsed = same ? (JSON.parse(same) as ModelAccess | null) : null
    return parsed?.mode ? parsed : { mode: 'all', models: [] }
  })
  const [notes, setNotes] = useState(
    sameValue(accounts.map((a) => a.config.notes || ''))
  )
  const [bps, setBps] = useState<BpsBulkValue>(emptyBpsBulk)
  const [proxyId, setProxyId] = useState('inline')
  const [endpoint, setEndpoint] = useState('')
  const [groupEnabled, setGroupEnabled] = useState(false)
  const [mode, setMode] = useState<GroupMode>('add')
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BulkResult | null>(null)
  const names = new Map(accounts.map((a) => [a.id, a.name]))
  const changed = groupEnabled || Object.values(enabled).some(Boolean)
  const valuesOf = (pick: (a: GatewayAccount) => unknown) => [
    ...new Set(accounts.map((a) => String(pick(a) ?? '—') || '—')),
  ]
  const current = (pick: (a: GatewayAccount) => unknown) =>
    valuesOf(pick).join(' / ')
  // 只在取值不一致、输入框无法表达时列出各账号当前值
  const mixed = (pick: (a: GatewayAccount) => unknown) => {
    const values = valuesOf(pick)
    return values.length > 1 ? values.join(' / ') : undefined
  }
  const toggle = (field: Field, on: boolean) =>
    setEnabled((v) => ({ ...v, [field]: on }))
  function patch() {
    const out: Record<string, unknown> = {}
    const integer = (value: string, min: number, max: number, key: string) => {
      const n = Number(value)
      if (value === '' || !Number.isInteger(n) || n < min || n > max)
        throw new Error(t('vm:vmBulk.rangeError', { field: t(key), min, max }))
      return n
    }
    if (enabled.status) {
      if (!status)
        throw new Error(
          t('vm:vmBulk.valueRequired', { field: t('vm:vmBulk.schedulable') })
        )
      out.status = status
    }
    if (enabled.max_concurrency)
      out.max_concurrency = integer(
        concurrency,
        1,
        1000,
        'gatewayWorkerConcurrency'
      )
    if (enabled.max_rpm) out.max_rpm = integer(rpm, 0, 1000000, 'codexRpmLimit')
    if (enabled.weight) out.weight = integer(weight, 1, 100, 'codexWeight')
    if (enabled.model_access) {
      if (modelAccess.mode !== 'all' && !modelAccess.models.length)
        throw new Error(t('codexModelAccessRequired'))
      out.model_access = modelAccess
    }
    if (enabled.notes) out.notes = notes
    if (enabled.bps) {
      const patch = bpsBulkPatch(bps, (key) => new Error(t(key)))
      if (!patch) throw new Error(t('vm:vmBulk.noChanges'))
      out.bps = patch
    }
    if (enabled.proxy) {
      if (proxyId === 'inline') {
        if (!endpoint.trim()) throw new Error(t('vendor:proxyRequiredForBoot'))
        out.proxy_endpoint = endpoint.trim()
      } else out.proxy_id = proxyId
    }
    if (groupEnabled) {
      if (!groupIds.length) throw new Error(t('vm:vmBulk.groupRequired'))
      out.groups = { operation: mode, ids: groupIds }
    }
    if (!Object.keys(out).length) throw new Error(t('vm:vmBulk.noChanges'))
    return out
  }
  async function save() {
    setError('')
    setResult(null)
    let body
    try {
      body = patch()
    } catch (e) {
      setError((e as Error).message)
      return
    }
    setBusy(true)
    try {
      const data = await api<BulkResult>(`${accountBase}/bulk-edit`, {
        method: 'POST',
        body: JSON.stringify({ ids: accounts.map((a) => a.id), patch: body }),
      })
      const failed = data.items.filter((item) => !item.ok)
      const saved = data.items.filter((item) => item.ok).map((item) => item.id)
      await onSaved(saved)
      if (failed.length) {
        setResult(data)
        setError(t('vm:vmBulk.partial'))
        return
      }
      toast.success(t('codexBulkSaved', { count: data.updated }))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function exportFile() {
    if (!window.confirm(t('codexExportConfirm'))) return
    setError('')
    setBusy(true)
    try {
      const data = await exportGatewayAccounts(accounts.map((a) => a.id))
      if (data.failed.length)
        setError(
          t('codexExportPartial', {
            names: data.failed
              .map((item) => `${item.name}（${item.error.message || ''}）`)
              .join('、'),
          })
        )
      else
        toast.success(t('codexExported', { count: data.file.accounts.length }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const fieldHead = (field: Field, label: string, value?: string) => (
    <>
      <label className='flex items-center gap-2 text-sm font-medium'>
        <Checkbox
          checked={!!enabled[field]}
          onCheckedChange={(on) => toggle(field, on === true)}
        />
        {label}
      </label>
      {value ? (
        <p className='text-xs text-muted-foreground'>
          {t('vm:vmBulk.current', { value })}
        </p>
      ) : null}
    </>
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl'
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('codexBulkTitle')}</DialogTitle>
          <DialogDescription>
            {t('codexBulkDescription', { count: accounts.length })}
          </DialogDescription>
        </DialogHeader>
        <QueryGate loading={catalog.isPending} error={catalog.error}>
          <fieldset disabled={busy} className='min-w-0 space-y-4'>
            <div className='space-y-2 border-b pb-4'>
              {fieldHead(
                'status',
                t('vm:vmBulk.schedulable'),
                mixed((a) =>
                  a.status === 'active'
                    ? t('vm:vmBulk.enabledValue')
                    : t('vm:vmBulk.disabledValue')
                )
              )}
              <select
                className={selectClass}
                aria-label={t('vm:vmBulk.schedulable')}
                disabled={!enabled.status}
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as '' | 'active' | 'paused')
                }
              >
                <option value=''>{t('vm:vmBulk.choose')}</option>
                <option value='active'>{t('vm:vmBulk.enable')}</option>
                <option value='paused'>{t('vm:vmBulk.disable')}</option>
              </select>
            </div>
            <div className='grid gap-4 border-b pb-4 sm:grid-cols-3'>
              <div className='space-y-2'>
                {fieldHead('max_concurrency', t('gatewayWorkerConcurrency'))}
                <Input
                  type='number'
                  min={1}
                  max={1000}
                  step={1}
                  disabled={!enabled.max_concurrency}
                  aria-label={t('gatewayWorkerConcurrency')}
                  placeholder={t('vm:vmBulk.mixed')}
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                />
              </div>
              <div className='space-y-2'>
                {fieldHead('max_rpm', t('codexRpmLimit'))}
                <Input
                  type='number'
                  min={0}
                  max={1000000}
                  step={1}
                  disabled={!enabled.max_rpm}
                  aria-label={t('codexRpmLimit')}
                  placeholder={t('vm:vmBulk.mixed')}
                  value={rpm}
                  onChange={(e) => setRpm(e.target.value)}
                />
              </div>
              <div className='space-y-2'>
                {fieldHead('weight', t('codexWeight'))}
                <Input
                  type='number'
                  min={1}
                  max={100}
                  step={1}
                  disabled={!enabled.weight}
                  aria-label={t('codexWeight')}
                  placeholder={t('vm:vmBulk.mixed')}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
              </div>
            </div>
            <div className='space-y-2 border-b pb-4'>
              {fieldHead(
                'model_access',
                t('codexModelAccess'),
                mixed((a) =>
                  t(
                    `codexModelAccessModes.${a.config.model_access?.mode || 'all'}`
                  )
                )
              )}
              <fieldset disabled={!enabled.model_access}>
                <ModelAccessField
                  value={modelAccess}
                  onChange={setModelAccess}
                />
              </fieldset>
            </div>
            <div className='space-y-2 border-b pb-4'>
              {fieldHead(
                'proxy',
                t('vendor:proxy'),
                current((a) => a.config.proxy_endpoint)
              )}
              <select
                className={selectClass}
                aria-label={t('vendor:proxy')}
                disabled={!enabled.proxy}
                value={proxyId}
                onChange={(e) => setProxyId(e.target.value)}
              >
                <option value='inline'>{t('codexInlineProxy')}</option>
                {catalog.data?.proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.name || `${proxy.host}:${proxy.port}`}
                  </option>
                ))}
              </select>
              {proxyId === 'inline' ? (
                <Input
                  disabled={!enabled.proxy}
                  aria-label={t('codexInlineProxy')}
                  placeholder={t('codexProxyPlaceholder')}
                  autoComplete='off'
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              ) : null}
            </div>
            <div className='space-y-2 border-b pb-4'>
              {fieldHead('notes', t('vendor:wb.column.notes'))}
              <Textarea
                disabled={!enabled.notes}
                maxLength={2000}
                aria-label={t('vendor:wb.column.notes')}
                placeholder={t('vm:vmBulk.mixed')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className='space-y-2 border-b pb-4'>
              {fieldHead(
                'bps',
                t('codexBpsTitle'),
                t('codexBpsBulkAuthorized', {
                  count: accounts.filter((a) => a.config.bps_grant).length,
                  total: accounts.length,
                })
              )}
              <fieldset disabled={!enabled.bps}>
                <BpsBulkFields
                  value={bps}
                  onChange={setBps}
                  groups={catalog.data?.groups}
                />
              </fieldset>
            </div>
            <div className='space-y-3'>
              <label className='flex items-center gap-2 text-sm font-medium'>
                <Checkbox
                  checked={groupEnabled}
                  onCheckedChange={(on) => setGroupEnabled(on === true)}
                />
                {t('vm:vmBulk.editGroups')}
              </label>
              <fieldset disabled={!groupEnabled} className='space-y-3'>
                <select
                  className={selectClass}
                  aria-label={t('vm:vmBulk.groupOperation')}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as GroupMode)}
                >
                  {(['add', 'remove', 'replace'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`vm:vmBulk.${m}`)}
                    </option>
                  ))}
                </select>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {catalog.data?.groups.map((g) => (
                    <label
                      key={g.id}
                      className='flex items-center gap-2 rounded-md border p-3 text-sm'
                    >
                      <Checkbox
                        checked={groupIds.includes(g.id)}
                        onCheckedChange={(on) =>
                          setGroupIds((v) =>
                            on === true
                              ? [...v, g.id]
                              : v.filter((id) => id !== g.id)
                          )
                        }
                      />
                      <span className='min-w-0 break-words'>
                        {g.name}
                        <span className='block text-xs text-muted-foreground'>
                          {t('codexBulkMembers', {
                            count: accounts.filter((a) =>
                              a.config.group_ids?.includes(g.id)
                            ).length,
                            total: accounts.length,
                          })}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('codexBulkHelp')}
            </p>
          </fieldset>
        </QueryGate>
        {error ? (
          <div
            role='alert'
            className='space-y-1 rounded-md border border-destructive/40 p-3 text-sm'
          >
            <p>{error}</p>
            {result?.items
              .filter((item) => !item.ok)
              .map((item) => (
                <p key={item.id} className='text-destructive'>
                  {names.get(item.id) || item.id}：
                  {item.error?.message || t('codexActionFailed')}
                </p>
              ))}
          </div>
        ) : null}
        <DialogFooter className='items-center'>
          <span className='me-auto text-xs text-muted-foreground'>
            {t('codexBulkKeep', { count: accounts.length })}
          </span>
          <Button
            variant='ghost'
            disabled={busy}
            onClick={() => void exportFile()}
          >
            {t('codexExportFile')}
          </Button>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !changed} onClick={() => void save()}>
            {busy ? t('vm:vmBulk.saving') : t('vm:vmBulk.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function sameValue(values: unknown[]): string {
  const set = new Set(values.map((v) => (v == null ? '' : String(v))))
  return set.size === 1 ? [...set][0] : ''
}

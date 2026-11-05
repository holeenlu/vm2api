import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { idempotencyKey } from '@/lib/idempotency-key'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { QueryGate } from '@/components/query-gate'
import type { Resource } from '@/features/vendor/portal-model'
import { AccountProxyInput } from '@/features/vendor/proxy-input'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import {
  accountBase,
  bpsViewOf,
  operatorBpsEndpoints,
  type BpsSettings,
  type GatewayAccount,
  offersBpsStep,
  type GatewayCatalog,
  type ModelAccess,
} from './accounts-model'
import { BpsAuthorize, BpsSection } from './bps-section'
import { ModelAccessField } from './model-access-field'

type Mode = 'create' | 'edit' | 'authorize'
export function GatewayAccountDialog({
  account,
  mode,
  onClose,
  onChanged,
}: {
  account?: GatewayAccount
  mode: Mode
  onClose: () => void
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  const accountId = account?.id
  const catalog = useQuery({
    queryKey: ['gateway-account-catalog', accountId],
    queryFn: () =>
      api<GatewayCatalog>(
        accountId
          ? `${accountBase}/${accountId}/catalog`
          : `${accountBase}/catalog`
      ),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              mode === 'create'
                ? 'codexCreate'
                : mode === 'edit'
                  ? 'codexEdit'
                  : 'reauthorize'
            )}
            {account ? ` · ${account.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {t(
              mode === 'create'
                ? 'codexCreateHelp'
                : mode === 'edit'
                  ? 'codexEditHelp'
                  : 'codexAuthorizeHelp'
            )}
          </DialogDescription>
        </DialogHeader>
        <QueryGate loading={catalog.isPending} error={catalog.error}>
          {catalog.data && (
            <AccountForm
              account={account}
              mode={mode}
              catalog={catalog.data}
              busy={busy}
              onBusy={setBusy}
              onClose={onClose}
              onChanged={onChanged}
            />
          )}
        </QueryGate>
      </DialogContent>
    </Dialog>
  )
}
function AccountForm({
  account,
  mode,
  catalog,
  busy,
  onBusy,
  onClose,
  onChanged,
}: {
  account?: GatewayAccount
  mode: Mode
  catalog: GatewayCatalog
  busy: boolean
  onBusy: (value: boolean) => void
  onClose: () => void
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation(['common', 'vendor', 'vm'])
  const [name, setName] = useState(account?.name || '')
  const [notes, setNotes] = useState(account?.config.notes || '')
  const [groups, setGroups] = useState<number[]>(
    account?.config.group_ids || []
  )
  // Same proxy combobox as the supplier form: pick a saved proxy or paste one.
  const [proxy, setProxy] = useState({ proxy_id: '', proxy_endpoint: '' })
  const keepProxy = !!account && !proxy.proxy_id && !proxy.proxy_endpoint.trim()
  const proxyOptions: Resource[] = catalog.proxies.map((item) => ({
    id: item.id,
    vendor_id: '',
    name: item.name || `${item.host}:${item.port}`,
    resource_type: 'proxy',
    status: 'active',
    created_at: '',
    config: { endpoint: `${item.host}:${item.port}`, available: true },
  }))
  const [concurrency, setConcurrency] = useState(
    account?.config.max_concurrency || 4
  )
  const [rpm, setRpm] = useState(account?.config.max_rpm || 0)
  // CPR 账号设置：调度开关、权重 1–100、模型范围。
  const [enabled, setEnabled] = useState(account?.status !== 'paused')
  const [resetCreditAuto, setResetCreditAuto] = useState(
    account?.config.reset_credit_auto === true
  )
  const [weight, setWeight] = useState(account?.config.weight || 1)
  const [modelAccess, setModelAccess] = useState<ModelAccess>(
    account?.config.model_access || { mode: 'all', models: [] }
  )
  const [error, setError] = useState('')
  const [prepared, setPrepared] = useState(false)
  const key = useRef(idempotencyKey())
  const draft = useRef('')
  const pending = useRef<Promise<string> | null>(null)
  // BPS 设置随“保存”提交（只在账号已授权 BPS 时）；新建账号完成 OAuth 后进入可选的“添加 BPS 授权”步骤
  const [bps, setBps] = useState<BpsSettings | null>(
    account?.config.bps || null
  )
  const [created, setCreated] = useState<GatewayAccount | null>(null)
  function body() {
    if (account && !name.trim()) throw new Error(t('codexNameRequired'))
    if (!groups.length) throw new Error(t('vendor:groupsRequired'))
    if (!account && !proxy.proxy_id && !proxy.proxy_endpoint.trim())
      throw new Error(t('vendor:proxyRequiredForBoot'))
    if (!Number.isInteger(weight) || weight < 1 || weight > 100)
      throw new Error(t('codexWeightRange'))
    if (modelAccess.mode !== 'all' && !modelAccess.models.length)
      throw new Error(t('codexModelAccessRequired'))
    return {
      name: name.trim(),
      notes,
      group_ids: groups,
      max_concurrency: concurrency,
      max_rpm: rpm,
      weight,
      model_access: modelAccess,
      reset_credit_auto: resetCreditAuto,
      status: enabled ? 'active' : 'paused',
      ...(account?.config.bps_grant && bps ? { bps } : {}),
      ...(keepProxy
        ? {}
        : proxy.proxy_id
          ? { proxy_id: proxy.proxy_id }
          : { proxy_endpoint: proxy.proxy_endpoint.trim() }),
    }
  }
  async function prepareDraft(authorizationKind: string): Promise<string> {
    if (draft.current) return draft.current
    if (pending.current) return pending.current
    const task = (async () => {
      setError('')
      try {
        const payload = mode === 'authorize' ? {} : body()
        const response = await api<{ draft: { id: string } }>(
          account
            ? `${accountBase}/${account.id}/drafts`
            : `${accountBase}/drafts`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...payload,
              authorization_kind: authorizationKind,
              idempotency_key: key.current,
            }),
          }
        )
        draft.current = response.draft.id
        setPrepared(true)
        return draft.current
      } catch (error) {
        setError((error as Error).message)
        throw error
      }
    })()
    pending.current = task
    try {
      return await task
    } finally {
      pending.current = null
    }
  }
  async function save() {
    setError('')
    try {
      const payload = body()
      onBusy(true)
      const result = await api<{ projection_pending?: boolean }>(
        `${accountBase}/${account!.id}`,
        { method: 'PATCH', body: JSON.stringify(payload) }
      )
      if (result.projection_pending) toast.warning(t('codexProjectionPending'))
      else toast.success(t('codexActionDone'))
      await onChanged()
      onClose()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      onBusy(false)
    }
  }
  if (created)
    return (
      <div className='space-y-3'>
        <div>
          <h3 className='text-sm font-semibold'>{t('codexBpsAddStep')}</h3>
          <p className='text-xs text-muted-foreground'>
            {t('codexBpsAddStepHelp')}
          </p>
        </div>
        <BpsAuthorize
          view={bpsViewOf(created)}
          endpoints={operatorBpsEndpoints(created.id)}
          onBusy={onBusy}
          onDone={async () => {
            toast.success(t('codexBpsAuthorized'))
            await onChanged()
            onClose()
          }}
        />
        <div className='flex justify-end'>
          <Button
            variant='outline'
            disabled={busy}
            onClick={async () => {
              await onChanged()
              onClose()
            }}
          >
            {t('codexBpsSkip')}
          </Button>
        </div>
      </div>
    )
  return (
    <div className='space-y-5'>
      {mode !== 'authorize' && (
        <fieldset
          disabled={busy || prepared}
          className='space-y-4 disabled:opacity-70'
        >
          <label className='grid gap-2 text-sm font-medium'>
            {t('vendor:accountName')}
            <Input
              maxLength={160}
              placeholder={
                account ? undefined : t('vendor:accountNamePlaceholder')
              }
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete='off'
            />
          </label>
          <div className='grid gap-2 text-sm font-medium'>
            <p>{t('vendor:proxy')}</p>
            {account ? (
              <p className='text-xs font-normal text-muted-foreground'>
                {t('codexKeepProxy')} · {account.config.proxy_endpoint || '—'}
              </p>
            ) : null}
            <AccountProxyInput
              endpoint={proxy.proxy_endpoint}
              proxyId={proxy.proxy_id}
              proxies={proxyOptions}
              onChange={setProxy}
              help={
                account?.vendor_id
                  ? t('codexInlineProxyVendorHelp')
                  : t('codexInlineProxyHelp')
              }
            />
          </div>
          <fieldset className='space-y-2 rounded-lg border p-3'>
            <legend className='px-1 text-sm font-medium'>
              {t('vendor:groups')}
            </legend>
            <div className='grid gap-2 sm:grid-cols-2'>
              {catalog.groups.map((group) => (
                <label
                  key={group.id}
                  className='flex items-center gap-2 text-sm'
                >
                  <Checkbox
                    checked={groups.includes(group.id)}
                    onCheckedChange={(checked) =>
                      setGroups(
                        checked
                          ? [...groups, group.id]
                          : groups.filter((id) => id !== group.id)
                      )
                    }
                  />
                  {group.name}
                </label>
              ))}
            </div>
            {!catalog.groups.length || !groups.length ? (
              <p className='text-xs text-muted-foreground'>
                {catalog.groups.length
                  ? t('vendor:groupsRequired')
                  : t('codexNoGroups')}
              </p>
            ) : null}
          </fieldset>
          <label className='flex items-center justify-between gap-3 rounded-lg border p-3 text-sm font-medium'>
            <span>{t('codexSchedule')}</span>
            <Switch
              checked={enabled}
              aria-label={t('codexSchedule')}
              onCheckedChange={setEnabled}
            />
          </label>
          <label className='flex items-center justify-between gap-3 rounded-lg border p-3 text-sm'>
            <span className='space-y-1'>
              <span className='block font-medium'>
                {t('codexResetCreditAuto')}
              </span>
              <span className='block text-xs text-muted-foreground'>
                {t('codexResetCreditAutoHelp')}
              </span>
            </span>
            <Switch
              checked={resetCreditAuto}
              aria-label={t('codexResetCreditAuto')}
              onCheckedChange={setResetCreditAuto}
            />
          </label>
          <div className='grid gap-4 sm:grid-cols-3'>
            <div className='space-y-2'>
              <Label htmlFor='gateway-concurrency'>
                {t('gatewayWorkerConcurrency')}
              </Label>
              <Input
                id='gateway-concurrency'
                type='number'
                min={1}
                max={1000}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='gateway-rpm'>{t('codexRpmLimit')}</Label>
              <Input
                id='gateway-rpm'
                type='number'
                min={0}
                max={1000000}
                value={rpm}
                onChange={(event) => setRpm(Number(event.target.value))}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='gateway-weight'>{t('codexWeight')}</Label>
              <Input
                id='gateway-weight'
                type='number'
                min={1}
                max={100}
                value={weight}
                onChange={(event) => setWeight(Number(event.target.value))}
              />
            </div>
          </div>
          <p className='-mt-2 text-xs text-muted-foreground'>
            {t('codexWeightHelp')}
          </p>
          <ModelAccessField value={modelAccess} onChange={setModelAccess} />
          <div className='space-y-2'>
            <Label htmlFor='gateway-notes'>{t('vendor:wb.column.notes')}</Label>
            <Textarea
              id='gateway-notes'
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </fieldset>
      )}
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      {mode === 'edit' && account ? (
        <BpsSection
          view={bpsViewOf(account)}
          endpoints={operatorBpsEndpoints(account.id)}
          groups={catalog.groups}
          value={bps}
          onChange={setBps}
          onChanged={onChanged}
          modelAccess={modelAccess}
        />
      ) : null}
      {mode === 'edit' ? (
        <div className='flex justify-end gap-2'>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy} onClick={save}>
            {t('vendor:wb.save')}
          </Button>
        </div>
      ) : (
        <>
          {!catalog.worker_available && (
            <p role='alert' className='text-sm text-amber-600'>
              {t('codexNoWorker')}
            </p>
          )}
          <fieldset
            disabled={!catalog.worker_available || !catalog.groups.length}
            className='space-y-3 border-t pt-4 disabled:opacity-60'
            aria-label={t('vendor:authMethod')}
          >
            <h3 className='text-sm font-semibold'>{t('vendor:authMethod')}</h3>
            <CodexCredentialPanel
              gatewayAccount
              vm={{
                id: '',
                name,
                platform: 'openai',
                family: 'codex',
                can_import_credential: true,
              }}
              draftApiBase={`${accountBase}/drafts`}
              prepareDraft={prepareDraft}
              onBusyChange={onBusy}
              onCommitted={async (data) => {
                const result = data as {
                  projection_pending?: boolean
                  account?: GatewayAccount
                }
                if (result.projection_pending)
                  toast.warning(t('codexProjectionPending'))
                // 新建账号授权成功后不关闭：Worker 支持 BPS 授权时可选地继续添加（按能力描述，P6.3）
                if (
                  mode === 'create' &&
                  result.account &&
                  offersBpsStep(catalog)
                ) {
                  setCreated(result.account)
                  return
                }
                await onChanged()
                onClose()
              }}
            />
          </fieldset>
          {prepared && (
            <p className='text-xs text-muted-foreground'>
              {t('codexDraftLocked')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

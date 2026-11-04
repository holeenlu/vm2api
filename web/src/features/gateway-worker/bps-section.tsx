import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TestModelsPayload } from '@/types/panel-vm'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo, fmtExpiresAt } from '@/lib/format'
import { idempotencyKey } from '@/lib/idempotency-key'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { testModelsQueryOptions } from '@/features/vm/queries'
import {
  bpsStatusFrom,
  type BpsCatalog,
  type BpsProbe,
  type BpsEndpoints,
  type BpsSettings,
  type BpsView,
} from './accounts-model'

/** BPS 授权状态一行：未授权 / 有效 / 需重新授权 / 403 已停用（时刻）/ 已关闭。 */
export function BpsStatusText({ view }: { view: BpsView }) {
  const { t } = useTranslation('common')
  const status = bpsStatusFrom(view)
  const blockedAt = view.bps_blocked_at
  return (
    <span
      className={
        status === 'active'
          ? 'text-emerald-600'
          : status === 'none' || status === 'off'
            ? 'text-muted-foreground'
            : 'text-amber-600'
      }
    >
      {t(`codexBpsStatus.${status}`)}
      {status === 'blocked' && blockedAt ? ` · ${fmtAgo(blockedAt)}` : ''}
      {status === 'blocked' && view.bps_recovery
        ? ` · ${
            view.bps_recovery === 'auto' && view.bps_next_probe_at
              ? t('codexBpsRecoveryNext', {
                  time: fmtExpiresAt(view.bps_next_probe_at),
                })
              : t(`codexBpsRecovery.${view.bps_recovery}`)
          }`
        : ''}
      {view.bps_cooldown_until &&
      new Date(view.bps_cooldown_until).getTime() > Date.now()
        ? ` · ${t('codexBpsCooldown', {
            time: fmtExpiresAt(view.bps_cooldown_until),
            reason: view.bps_error || '—',
          })}`
        : ''}
    </span>
  )
}

/** 最近的 403 恢复探测：时间、模型、结果与 token（探测不进使用记录、不计费）。 */
export function BpsProbeList({ probes }: { probes?: BpsProbe[] }) {
  const { t } = useTranslation('common')
  if (!probes?.length) return null
  return (
    <div className='space-y-1'>
      <p className='text-xs font-medium'>{t('codexBpsProbes')}</p>
      <ul className='space-y-0.5 text-xs text-muted-foreground'>
        {probes.slice(0, 5).map((probe) => (
          <li key={probe.probed_at} className='flex flex-wrap gap-x-2'>
            <span>{fmtAgo(probe.probed_at)}</span>
            <span className='font-mono'>{probe.model}</span>
            <span className={probe.ok ? 'text-emerald-600' : 'text-amber-600'}>
              {probe.ok
                ? t('codexBpsProbeOk')
                : t('codexBpsProbeFailed', {
                    reason: probe.error_code || probe.status || '—',
                  })}
            </span>
            <span>
              {t('codexBpsProbeTokens', { tokens: probe.total_tokens })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 为已有账号添加或重新授权 BPS：授权链接（粘贴 bps.openai.com 回调）或导入 Excel 授权文件。 */
export function BpsAuthorize({
  view,
  endpoints,
  onBusy,
  onDone,
}: {
  view: BpsView
  endpoints: BpsEndpoints
  onBusy?: (busy: boolean) => void
  onDone: () => Promise<unknown> | void
}) {
  const key = useRef(idempotencyKey())
  const draft = useRef('')
  async function prepareDraft(authorizationKind: string) {
    if (draft.current) return draft.current
    const response = await api<{ draft: { id: string } }>(endpoints.drafts, {
      method: 'POST',
      body: JSON.stringify({
        authorization_kind: authorizationKind,
        idempotency_key: key.current,
      }),
    })
    draft.current = response.draft.id
    return draft.current
  }
  return (
    <CodexCredentialPanel
      gatewayAccount
      bpsImportPath={endpoints.import}
      vm={{
        id: '',
        name: view.name,
        platform: 'openai',
        family: 'codex',
        can_import_credential: true,
      }}
      draftApiBase={endpoints.draftApiBase}
      prepareDraft={prepareDraft}
      onBusyChange={onBusy}
      onCommitted={async () => {
        await onDone()
      }}
    />
  )
}

/** 编辑账号里的 BPS 分区：授权状态与操作（立即生效），以及随“保存”提交的 BPS 设置。 */
export function BpsSection({
  view,
  endpoints,
  groups,
  value,
  onChange,
  onChanged,
}: {
  view: BpsView
  endpoints: BpsEndpoints
  groups: { id: number; name: string }[]
  value: BpsSettings | null
  onChange: (next: BpsSettings) => void
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [authorizing, setAuthorizing] = useState(false)
  const [busy, setBusy] = useState(false)
  const authorized = !!view.bps_grant
  async function recoveryAction(action: 'unblock' | 'recovery/stop') {
    if (action === 'unblock' && !window.confirm(t('codexBpsUnblockConfirm')))
      return
    setBusy(true)
    try {
      await api(`${endpoints.bps}/${action}`, { method: 'POST', body: '{}' })
      toast.success(
        t(
          action === 'unblock' ? 'codexBpsUnblocked' : 'codexBpsRecoveryStopped'
        )
      )
      await onChanged()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const blocked = view.bps_state === 'blocked'
  async function revoke() {
    if (!window.confirm(t('codexBpsRevokeConfirm'))) return
    setBusy(true)
    try {
      await api(endpoints.bps, { method: 'DELETE' })
      toast.success(t('codexBpsRevoked'))
      await onChanged()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const set = (patch: Partial<BpsSettings>) =>
    value && onChange({ ...value, ...patch })
  return (
    <section
      aria-label={t('codexBpsTitle')}
      className='space-y-3 rounded-lg border p-3'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h3 className='text-sm font-semibold'>{t('codexBpsTitle')}</h3>
          <p className='text-xs text-muted-foreground'>
            <BpsStatusText view={view} />
          </p>
        </div>
        <div className='flex gap-2'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => setAuthorizing((open) => !open)}
          >
            {authorized ? t('codexBpsReauthorize') : t('codexBpsAuthorize')}
          </Button>
          {authorized && blocked ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => recoveryAction('unblock')}
            >
              {t('codexBpsUnblock')}
            </Button>
          ) : null}
          {authorized && blocked && view.bps_recovery === 'auto' ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              disabled={busy}
              onClick={() => recoveryAction('recovery/stop')}
            >
              {t('codexBpsStopRecovery')}
            </Button>
          ) : null}
          {authorized ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              disabled={busy}
              onClick={revoke}
            >
              {t('codexBpsRevoke')}
            </Button>
          ) : null}
        </div>
      </div>
      {authorizing ? (
        <BpsAuthorize
          view={view}
          endpoints={endpoints}
          onBusy={setBusy}
          onDone={async () => {
            setAuthorizing(false)
            toast.success(t('codexBpsAuthorized'))
            await onChanged()
          }}
        />
      ) : null}
      {view.bps_verification ? (
        <p
          className={
            view.bps_verification.ok
              ? 'text-xs text-emerald-600'
              : 'text-xs text-amber-600'
          }
        >
          {t(
            view.bps_verification.ok
              ? 'codexBpsVerifiedOk'
              : 'codexBpsVerifiedFailed',
            {
              model: view.bps_verification.model,
              ago: fmtAgo(view.bps_verification.verified_at),
              code: view.bps_verification.error_code || '',
            }
          )}
        </p>
      ) : null}
      <BpsProbeList probes={view.bps_probes} />
      {authorized && value ? (
        <BpsSettingsFields
          value={value}
          groups={groups}
          onChange={set}
          catalog={view.bps_catalog || null}
          catalogUrl={`${endpoints.bps}/models`}
        />
      ) : (
        <p className='text-xs text-muted-foreground'>{t('codexBpsHelp')}</p>
      )}
    </section>
  )
}

function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className='flex items-start justify-between gap-3 text-sm'>
      <span>
        <span className='font-medium'>{label}</span>
        <span className='block text-xs text-muted-foreground'>{help}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

function BpsSettingsFields({
  value,
  groups,
  onChange,
  catalog,
  catalogUrl,
}: {
  value: BpsSettings
  groups: { id: number; name: string }[]
  onChange: (patch: Partial<BpsSettings>) => void
  catalog: BpsCatalog | null
  catalogUrl: string
}) {
  const { t } = useTranslation('common')
  return (
    <div className='space-y-3'>
      <Toggle
        label={t('codexBpsEnabled')}
        help={t('codexBpsEnabledHelp')}
        checked={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      <div className='grid gap-1 text-sm font-medium'>
        <p>{t('codexBpsModels')}</p>
        <BpsModelPicker
          models={value.models}
          onChange={(models) => onChange({ models })}
          help={t('codexBpsModelsHelp')}
          catalog={catalog}
          catalogUrl={catalogUrl}
        />
      </div>
      <details className='space-y-3 rounded-md bg-muted/30 p-2'>
        <summary className='cursor-pointer text-sm font-medium'>
          {t('codexBpsAdvanced')}
        </summary>
        <div className='space-y-3 pt-2'>
          <Toggle
            label={t('codexBpsOmitTools')}
            help={t('codexBpsOmitToolsHelp')}
            checked={value.omit_unsupported_tools}
            onChange={(omit_unsupported_tools) =>
              onChange({ omit_unsupported_tools })
            }
          />
          <Toggle
            label={t('codexBpsIgnoreEncrypted')}
            help={t('codexBpsIgnoreEncryptedHelp')}
            checked={value.ignore_encrypted_content}
            onChange={(ignore_encrypted_content) =>
              onChange({ ignore_encrypted_content })
            }
          />
          <Toggle
            label={t('codexBpsCacheAsInput')}
            help={t('codexBpsCacheAsInputHelp')}
            checked={value.cache_creation_as_input}
            onChange={(cache_creation_as_input) =>
              onChange({ cache_creation_as_input })
            }
          />
          <Toggle
            label={t('codexBpsAutoDisable')}
            help={t('codexBpsAutoDisableHelp')}
            checked={value.auto_disable_on_403}
            onChange={(auto_disable_on_403) =>
              onChange({
                auto_disable_on_403,
                ...(auto_disable_on_403 ? {} : { auto_recover_on_403: false }),
              })
            }
          />
          {value.auto_disable_on_403 ? (
            <div className='space-y-2 border-l pl-3'>
              <Toggle
                label={t('codexBpsAutoRecover')}
                help={t('codexBpsAutoRecoverHelp')}
                checked={value.auto_recover_on_403}
                onChange={(auto_recover_on_403) =>
                  onChange({ auto_recover_on_403 })
                }
              />
              {value.auto_recover_on_403 ? (
                <div className='grid gap-1'>
                  <Label htmlFor='bps-recovery-interval'>
                    {t('codexBpsRecoveryInterval')}
                  </Label>
                  <Input
                    id='bps-recovery-interval'
                    type='number'
                    min={1}
                    max={10080}
                    value={value.recovery_interval_minutes}
                    onChange={(event) =>
                      onChange({
                        recovery_interval_minutes: Number(event.target.value),
                      })
                    }
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          <Toggle
            label={t('codexBpsAutoMove')}
            help={t('codexBpsAutoMoveHelp')}
            checked={value.auto_move_on_403}
            onChange={(auto_move_on_403) =>
              onChange({
                auto_move_on_403,
                target_group_id: auto_move_on_403
                  ? (value.target_group_id ?? 0)
                  : null,
              })
            }
          />
          {value.auto_move_on_403 ? (
            <div className='grid gap-1 border-l pl-3'>
              <Label htmlFor='bps-target-group'>
                {t('codexBpsTargetGroup')}
              </Label>
              <select
                id='bps-target-group'
                className='h-9 rounded-md border bg-background px-2 text-sm'
                value={value.target_group_id ?? 0}
                onChange={(event) =>
                  onChange({ target_group_id: Number(event.target.value) })
                }
              >
                <option value={0}>{t('codexBpsLeaveAllGroups')}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  )
}

/** BPS 模型名单：候选来自官方 BPS 模型目录（按需查询）与站内 OpenAI 模型目录，回车可添加目录外的精确 ID（不接受通配符）。 */
function BpsModelPicker({
  models,
  onChange,
  help,
  catalog: savedCatalog,
  catalogUrl,
}: {
  models: string[]
  onChange: (next: string[]) => void
  help: string
  catalog: BpsCatalog | null
  catalogUrl: string
}) {
  const { t } = useTranslation('common')
  const [search, setSearch] = useState('')
  const [bpsCatalog, setBpsCatalog] = useState<BpsCatalog | null>(savedCatalog)
  const [fetching, setFetching] = useState(false)
  async function fetchCatalog() {
    setFetching(true)
    try {
      setBpsCatalog(await api<BpsCatalog>(`${catalogUrl}?refresh=1`))
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setFetching(false)
    }
  }
  const bpsModels = new Map(
    (bpsCatalog?.models || []).map((model) => [model.id, model])
  )
  const restricted = new Set(bpsCatalog?.restricted_models || [])
  const catalog = useQuery({
    queryKey: [...testModelsQueryOptions('').queryKey, 'openai'],
    queryFn: () =>
      api<TestModelsPayload>('/api/panel/test-models?platform=openai'),
  })
  const ids = [
    ...new Set([
      ...models,
      ...bpsModels.keys(),
      ...(catalog.data?.items || catalog.data?.models || []).map((m) => m.id),
    ]),
  ]
  const query = search.trim()
  const shown = ids.filter((id) =>
    id.toLowerCase().includes(query.toLowerCase())
  )
  const toggle = (id: string) =>
    onChange(
      models.includes(id) ? models.filter((m) => m !== id) : [...models, id]
    )
  const unavailable = bpsCatalog
    ? models.filter((id) => !bpsModels.has(id) && !id.startsWith('gpt-image'))
    : []
  return (
    <div className='space-y-2 rounded-lg border p-3 font-normal'>
      <div className='flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground'>
        <span>
          {bpsCatalog
            ? bpsCatalog.allowed
              ? t('codexBpsCatalogFetched', {
                  count: bpsCatalog.models.length,
                  ago: fmtAgo(bpsCatalog.fetched_at),
                })
              : t('codexBpsCatalogDenied')
            : t('codexBpsCatalogNone')}
        </span>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={fetching}
          onClick={fetchCatalog}
        >
          {t('codexBpsCatalogFetch')}
        </Button>
      </div>
      {unavailable.length ? (
        <p className='text-xs text-amber-600'>
          {t('codexBpsCatalogUnavailable', { models: unavailable.join(', ') })}
        </p>
      ) : null}
      <Input
        value={search}
        placeholder={t('codexModelAccessSearch')}
        aria-label={t('codexModelAccessSearch')}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !query) return
          event.preventDefault()
          if (!query.includes('*') && !models.includes(query))
            onChange([...models, query])
          setSearch('')
        }}
      />
      {models.length ? (
        <div className='flex flex-wrap gap-1'>
          {models.map((id) => (
            <span
              key={id}
              className='inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs'
            >
              {id}
              <button
                type='button'
                aria-label={t('codexModelAccessRemove', { id })}
                onClick={() => toggle(id)}
              >
                <X className='size-3' />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className='grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2'>
        {shown.map((id) => (
          <label key={id} className='flex items-center gap-2 font-mono text-xs'>
            <input
              type='checkbox'
              checked={models.includes(id)}
              onChange={() => toggle(id)}
            />
            <span
              className={
                restricted.has(id) || bpsModels.get(id)?.cooling_down
                  ? 'text-amber-600'
                  : bpsModels.has(id)
                    ? 'text-emerald-600'
                    : undefined
              }
            >
              {id}
            </span>
            {bpsModels.get(id)?.reasoning_efforts.length ? (
              <span className='text-muted-foreground'>
                {bpsModels.get(id)?.reasoning_efforts.join('/')}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      <p className='text-xs text-muted-foreground'>{help}</p>
    </div>
  )
}

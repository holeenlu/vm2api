import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type {
  ApiEndpoint,
  ApiEndpointPreset,
  ApiKeyEntry,
  ApiModelEntry,
} from '@/types/panel-api-endpoints'
import { ChevronRight, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { modelPolicyQueryOptions } from '@/features/models/queries'
import {
  PROXY_DIRECT,
  PROXY_SAVED,
  ProxyPicker,
} from '@/features/proxies/proxy-picker'
import {
  appendSystemModels,
  hasModelDraftContent,
  systemEndpointModels,
} from './default-models'

type EndpointKind = 'claude' | 'openai' | 'custom'
type Protocol = 'anthropic' | 'openai'
type EpAuthScheme = 'x_api_key' | 'authorization_bearer'

const KIND_LABEL_KEYS: Record<EndpointKind, string> = {
  claude: 'apiEndpoints:claudeOfficial',
  openai: 'apiEndpoints:openaiOfficial',
  custom: 'apiEndpoints:custom',
}

/** Draft key (create mode or the add-key row) in the test-result map. */
const DRAFT_KEY = '__draft__'

type KeyTestResult = {
  ok?: boolean
  status?: number
  text?: string
  error?: string
  proxy?: boolean
}

/** Grid shared by the model table header and its rows. */
const MODEL_GRID =
  'grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem_minmax(0,1fr)_2.25rem]'

type ModelDraft = {
  name: string
  alias: string
  image: boolean
  thinking: string
}

export function EndpointDetailSheet({
  open,
  endpoint,
  presets,
  onOpenChange,
}: {
  open: boolean
  endpoint: ApiEndpoint | null
  presets: ApiEndpointPreset[]
  onOpenChange: (open: boolean) => void
}) {
  useTranslation('apiEndpoints')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
        {open ? (
          <EndpointForm
            key={endpoint?.id ?? 'create'}
            endpoint={endpoint}
            presets={presets}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EndpointForm({
  endpoint,
  presets,
  onOpenChange,
}: {
  endpoint: ApiEndpoint | null
  presets: ApiEndpointPreset[]
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('apiEndpoints')

  const qc = useQueryClient()
  const isEdit = !!endpoint
  const [kind, setKind] = useState<EndpointKind>(endpoint?.kind || 'claude')
  const [protocol, setProtocol] = useState<Protocol>(
    (endpoint?.protocol as Protocol) ||
      (presetFor(presets, kind).protocol as Protocol)
  )
  const [authScheme, setAuthScheme] = useState<EpAuthScheme>(
    endpoint?.auth_scheme ||
      (kind === 'openai' ? 'authorization_bearer' : 'x_api_key')
  )
  const [name, setName] = useState(
    endpoint?.name || presetFor(presets, kind).label
  )
  // Keep the auto-filled name stable across language changes, like the draft itself.
  const autoName = useRef(presetFor(presets, kind).label)
  const [baseUrl, setBaseUrl] = useState(
    endpoint?.base_url || presetFor(presets, kind).base_url
  )
  const [prefix, setPrefix] = useState(endpoint?.prefix || '')
  const [priority, setPriority] = useState(String(endpoint?.priority ?? 0))
  const [disableCooling, setDisableCooling] = useState(
    !!endpoint?.disable_cooling
  )
  const [headersText, setHeadersText] = useState(
    endpoint ? JSON.stringify(endpoint.headers || {}, null, 2) : ''
  )
  const [models, setModels] = useState<ModelDraft[]>(
    modelsFromEndpoint(endpoint)
  )
  const autoModels = useRef<ModelDraft[] | null>(null)
  const modelPolicy = useQuery({
    ...modelPolicyQueryOptions(kind === 'openai' ? 'openai' : 'anthropic'),
    enabled: kind !== 'custom',
  })
  const [newKey, setNewKey] = useState('')
  const [newProxyId, setNewProxyId] = useState(PROXY_DIRECT)
  const [testResults, setTestResults] = useState<Record<string, KeyTestResult>>(
    {}
  )
  const keys = endpoint?.api_key_entries || []
  const connectionLocked = endpoint?.connection_editable === false
  const canTest = protocol === 'anthropic'

  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiEndpointsQueryOptions().queryKey })

  useEffect(() => {
    if (kind === 'custom' || hasModelDraftContent(models)) return
    const defaults = systemEndpointModels(kind, modelPolicy.data).map(
      (model) => ({
        name: model.name,
        alias: model.alias,
        image: !!model.image,
        thinking: (model.thinking?.levels || []).join(','),
      })
    )
    if (defaults.length) {
      autoModels.current = defaults
      setModels(defaults)
    }
  }, [kind, models, modelPolicy.data])

  const applyKind = (nextKind: EndpointKind) => {
    if (
      autoModels.current &&
      JSON.stringify(models) === JSON.stringify(autoModels.current)
    ) {
      setModels([])
    }
    autoModels.current = null
    const nextPreset = presetFor(presets, nextKind)
    setKind(nextKind)
    if (nextKind !== 'custom') {
      setBaseUrl(nextPreset.base_url)
      setProtocol((nextPreset.protocol as Protocol) || 'anthropic')
    }
    setAuthScheme(nextKind === 'openai' ? 'authorization_bearer' : 'x_api_key')
    // 名称为空、或仍是「自动填充」态时才跟着类型联动；用户改过名字就不再覆盖
    const autoNames = [autoName.current, 'api', '']
    if (autoNames.includes(name.trim())) {
      setName(nextKind === 'custom' ? '' : nextPreset.label)
    }
    autoName.current = nextPreset.label
  }

  const fetchModels = useMutation({
    mutationFn: async (): Promise<{
      models?: ApiModelEntry[]
      fetched?: number
      item?: ApiEndpoint
    }> => {
      if (!isEdit) {
        const key = newKey.trim()
        if (!key) throw new Error(t('apiEndpoints:keyRequired'))
        return api<{ models?: ApiModelEntry[] }>(
          '/api/panel/api-endpoints/fetch-models',
          {
            method: 'POST',
            body: JSON.stringify({
              kind,
              protocol,
              base_url: baseUrl.trim(),
              api_key: key,
              proxy_id: newProxyId,
              auth_scheme:
                kind === 'openai' ? 'authorization_bearer' : authScheme,
            }),
          }
        )
      }
      return api<{ fetched?: number; item?: ApiEndpoint }>(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint!.id)}/fetch-models`,
        { method: 'POST', body: JSON.stringify({ apply: true }) }
      )
    },
    onSuccess: async (data) => {
      if (!isEdit) {
        const fetched = data.models || []
        setModels(
          fetched.length
            ? fetched.map((m: ApiModelEntry) => ({
                name: m.name || '',
                alias: m.alias || '',
                image: !!m.image,
                thinking: (m.thinking?.levels || []).join(','),
              }))
            : modelsFromEndpoint(null)
        )
        toast.success(
          t('apiEndpoints:fetchedModels', { count: fetched.length })
        )
      } else {
        setModels(modelsFromEndpoint(data.item ?? null))
        toast.success(
          t('apiEndpoints:fetchedModels', {
            count: data.fetched ?? data.item?.models?.length ?? 0,
          })
        )
        await refresh()
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      if (!endpoint) {
        return api('/api/panel/api-endpoints', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      }
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      )
    },
    onSuccess: async () => {
      toast.success(
        isEdit ? t('apiEndpoints:saved') : t('apiEndpoints:addressAdded')
      )
      onOpenChange(false)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patchKey = useMutation({
    mutationFn: (body: {
      key_id?: string
      api_key?: string
      proxy_id: string
    }) => {
      if (!endpoint) throw new Error(t('apiEndpoints:addressNotFound'))
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}`,
        { method: 'PATCH', body: JSON.stringify(body) }
      )
    },
    onSuccess: async (_data, body) => {
      if (body.key_id) {
        toast.success(t('apiEndpoints:proxyUpdated'))
        setTestResults((current) => withoutResult(current, body.key_id!))
      } else {
        toast.success(t('apiEndpoints:keyAdded'))
        setNewKey('')
        setNewProxyId(PROXY_DIRECT)
        setTestResults((current) => withoutResult(current, DRAFT_KEY))
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const testKey = useMutation({
    mutationFn: async (slot: string) => {
      const model = models.find((row) => row.name.trim())?.name.trim()
      if (!model) throw new Error(t('apiEndpoints:testModelRequired'))
      const key =
        slot === DRAFT_KEY
          ? {
              api_key: newKey.trim(),
              base_url: baseUrl.trim(),
              auth_scheme: authScheme,
              proxy_id: newProxyId,
            }
          : { key_id: slot }
      if (slot === DRAFT_KEY && !key.api_key)
        throw new Error(t('apiEndpoints:keyRequired'))
      const data = await api<KeyTestResult & { items?: KeyTestResult[] }>(
        '/api/panel/anthropic/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model,
            max_tokens: 16,
            message: 'Hi',
            keys: [key],
            key_index: 0,
          }),
        }
      )
      return data.items?.[0] ?? data
    },
    onSuccess: (result, slot) =>
      setTestResults((current) => ({ ...current, [slot]: result })),
    onError: (error: Error) => toast.error(error.message),
  })

  const removeKey = useMutation({
    mutationFn: (kid: string) => {
      if (!endpoint) throw new Error(t('apiEndpoints:addressNotFound'))
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}/keys/${encodeURIComponent(kid)}`,
        { method: 'DELETE' }
      )
    },
    onSuccess: async () => {
      toast.success(t('apiEndpoints:keyDeleted'))
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const pending = save.isPending || patchKey.isPending || removeKey.isPending

  const draftResult = testResults[DRAFT_KEY]

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t('apiEndpoints:editAddress')
            : t('apiEndpoints:addAddress')}
        </DialogTitle>
        <DialogDescription className='break-all'>
          {isEdit
            ? [endpoint?.name || endpoint?.id, endpoint?.base_url]
                .filter(Boolean)
                .join(' · ')
            : t('apiEndpoints:detailDescription')}
        </DialogDescription>
      </DialogHeader>
      <div className='space-y-6'>
        <section className='space-y-4'>
          <h3 className='text-sm font-semibold'>
            {t('apiEndpoints:basicInfo')}
          </h3>
          <div className='grid gap-4 sm:grid-cols-2'>
            <Field label={t('apiEndpoints:kind')}>
              <Select
                disabled={connectionLocked}
                value={kind}
                onValueChange={(value) => applyKind(value as EndpointKind)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(presets.length
                    ? presets
                    : (['claude', 'openai', 'custom'] as EndpointKind[]).map(
                        (k) => ({
                          kind: k,
                          label: t(KIND_LABEL_KEYS[k]),
                        })
                      )
                  ).map((p) => (
                    <SelectItem key={p.kind} value={p.kind}>
                      {p.kind === 'claude' ||
                      p.kind === 'openai' ||
                      p.kind === 'custom'
                        ? t(KIND_LABEL_KEYS[p.kind])
                        : p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('apiEndpoints:name')}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='api'
              />
            </Field>
            {kind === 'custom' ? (
              <>
                <Field label={t('apiEndpoints:address')}>
                  <Input
                    disabled={connectionLocked}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder='https://api.example.com'
                  />
                </Field>
                <Field label={t('apiEndpoints:protocol')}>
                  <Select
                    disabled={connectionLocked}
                    value={protocol}
                    onValueChange={(value) => setProtocol(value as Protocol)}
                  >
                    <SelectTrigger className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='anthropic'>
                        Anthropic Messages
                      </SelectItem>
                      <SelectItem value='openai'>OpenAI Chat</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </>
            ) : null}
          </div>
          <div className='grid gap-4 sm:grid-cols-3'>
            <Field label={t('apiEndpoints:upstreamAuth')}>
              <Select
                disabled={connectionLocked}
                value={authScheme}
                onValueChange={(value) => setAuthScheme(value as EpAuthScheme)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='x_api_key'>x-api-key</SelectItem>
                  <SelectItem value='authorization_bearer'>
                    Authorization: Bearer
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('apiEndpoints:prefix')}>
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder={t('apiEndpoints:optional')}
              />
            </Field>
            <Field label={t('apiEndpoints:priority')}>
              <Input
                type='number'
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </Field>
          </div>
          <div className='flex items-start justify-between gap-4 rounded-md border px-3 py-2.5'>
            <div className='space-y-0.5'>
              <Label htmlFor='disable_cooling'>
                {t('apiEndpoints:disable429Cooling')}
              </Label>
              <p className='text-xs text-muted-foreground'>
                {t('apiEndpoints:disable429CoolingHint')}
              </p>
            </div>
            <Switch
              id='disable_cooling'
              checked={disableCooling}
              onCheckedChange={setDisableCooling}
            />
          </div>
        </section>

        <section className='space-y-3'>
          <h3 className='text-sm font-semibold'>
            {t('apiEndpoints:upstreamKey')}
          </h3>
          {isEdit ? (
            keys.length ? (
              <div className='divide-y rounded-md border'>
                {keys.map((entry) => (
                  <KeyRow
                    key={entry.id}
                    entry={entry}
                    busy={pending}
                    proxyLocked={connectionLocked}
                    canTest={canTest}
                    testing={
                      testKey.isPending && testKey.variables === entry.id
                    }
                    result={testResults[entry.id]}
                    onProxyChange={(proxy_id) => {
                      if (proxy_id === PROXY_SAVED) return
                      patchKey.mutate({ key_id: entry.id, proxy_id })
                    }}
                    onTest={() => testKey.mutate(entry.id)}
                    onRemove={() => removeKey.mutate(entry.id)}
                  />
                ))}
              </div>
            ) : (
              <p className='text-xs text-muted-foreground'>
                {t('apiEndpoints:noKeys')}
              </p>
            )
          ) : null}
          <div className='space-y-2'>
            {isEdit ? (
              <Label htmlFor='api_key'>{t('apiEndpoints:newKey')}</Label>
            ) : null}
            <div className='grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]'>
              <Input
                id='api_key'
                name='api_key'
                type='password'
                autoComplete='off'
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={kind === 'openai' ? 'sk-…' : 'sk-ant-…'}
                aria-label={t('apiEndpoints:upstreamKey')}
              />
              <ProxyPicker
                value={newProxyId}
                onChange={setNewProxyId}
                disabled={isEdit && connectionLocked}
                ariaLabel={t('apiEndpoints:proxy')}
              />
              <div className='flex gap-2'>
                {canTest ? (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={testKey.isPending || !newKey.trim()}
                    loading={
                      testKey.isPending && testKey.variables === DRAFT_KEY
                    }
                    onClick={() => testKey.mutate(DRAFT_KEY)}
                  >
                    {t('apiEndpoints:test')}
                  </Button>
                ) : null}
                {isEdit ? (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={pending || !newKey.trim()}
                    onClick={() =>
                      patchKey.mutate({
                        api_key: newKey.trim(),
                        proxy_id: newProxyId,
                      })
                    }
                  >
                    {t('apiEndpoints:addKey')}
                  </Button>
                ) : (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={fetchModels.isPending}
                    loading={fetchModels.isPending}
                    onClick={() => fetchModels.mutate()}
                  >
                    {t('apiEndpoints:fetchModels')}
                  </Button>
                )}
              </div>
            </div>
            {draftResult ? <TestResultLine result={draftResult} /> : null}
          </div>
        </section>

        <section className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='text-sm font-semibold'>
              {t('apiEndpoints:models')}
            </h3>
            <div className='flex flex-wrap items-center gap-2'>
              {kind !== 'custom' ? (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={!modelPolicy.data || modelPolicy.isFetching}
                  onClick={() =>
                    setModels((rows) =>
                      appendSystemModels(
                        rows.filter(
                          (row) => row.name.trim() || row.alias.trim()
                        ),
                        systemEndpointModels(kind, modelPolicy.data).map(
                          (model) => ({
                            name: model.name,
                            alias: model.alias,
                            image: !!model.image,
                            thinking: '',
                          })
                        )
                      )
                    )
                  }
                >
                  {t('apiEndpoints:addWhitelistModels')}
                </Button>
              ) : null}
              {isEdit ? (
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={fetchModels.isPending || keys.length === 0}
                  loading={fetchModels.isPending}
                  onClick={() => fetchModels.mutate()}
                >
                  {t('apiEndpoints:fetchModels')}
                </Button>
              ) : null}
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() =>
                  setModels((rows) => [
                    ...rows,
                    { name: '', alias: '', image: false, thinking: '' },
                  ])
                }
              >
                {t('apiEndpoints:addRow')}
              </Button>
            </div>
          </div>
          {models.length ? (
            <div className='space-y-2'>
              <div
                className={cn(
                  MODEL_GRID,
                  'hidden px-1 text-xs text-muted-foreground sm:grid'
                )}
              >
                <span>{t('apiEndpoints:upstreamModel')}</span>
                <span>{t('apiEndpoints:alias')}</span>
                <span className='text-center'>
                  {t('apiEndpoints:imageCapability')}
                </span>
                <span>{t('apiEndpoints:thinkingLevels')}</span>
                <span />
              </div>
              {models.map((row, index) => (
                <ModelRow
                  key={index}
                  row={row}
                  onChange={(next) =>
                    setModels((rows) =>
                      rows.map((item, i) =>
                        i === index ? { ...item, ...next } : item
                      )
                    )
                  }
                  onRemove={() =>
                    setModels((rows) => rows.filter((_, i) => i !== index))
                  }
                />
              ))}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>
              {t('apiEndpoints:noModelsHint')}
            </p>
          )}
        </section>

        <Collapsible
          defaultOpen={
            !!endpoint && Object.keys(endpoint.headers || {}).length > 0
          }
          className='group/advanced space-y-3'
        >
          <CollapsibleTrigger asChild>
            <button
              type='button'
              className='flex items-center gap-1 text-sm font-semibold'
            >
              <ChevronRight className='size-4 transition-transform group-data-[state=open]/advanced:rotate-90' />
              {t('apiEndpoints:advanced')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Field label={t('apiEndpoints:headersJson')}>
              <Textarea
                className='font-mono text-xs'
                rows={4}
                disabled={connectionLocked}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder='{"anthropic-beta":"…"}'
              />
            </Field>
          </CollapsibleContent>
        </Collapsible>

        {connectionLocked ? (
          <p className='text-sm text-muted-foreground'>
            {t('apiEndpoints:connectionAdminOnly')}
          </p>
        ) : null}
      </div>
      <DialogFooter className='sticky -bottom-6 -mx-6 -mb-6 border-t bg-background px-6 py-4'>
        <Button
          type='button'
          variant='outline'
          onClick={() => onOpenChange(false)}
        >
          {t('apiEndpoints:cancel')}
        </Button>
        <Button
          type='button'
          disabled={pending}
          onClick={() => {
            const headers = parseHeadersJson(headersText)
            if (!headers) {
              toast.error(t('apiEndpoints:invalidHeadersJson'))
              return
            }
            const api_key = newKey.trim()
            const body: Record<string, unknown> = {
              kind,
              protocol,
              name: name.trim() || 'api',
              base_url: baseUrl.trim(),
              prefix: prefix.trim(),
              priority: Number(priority || 0),
              disable_cooling: disableCooling,
              auth_scheme:
                kind === 'openai' ? 'authorization_bearer' : authScheme,
              headers,
              models: collectModels(models),
            }
            if (isEdit && connectionLocked) {
              for (const field of [
                'kind',
                'protocol',
                'base_url',
                'auth_scheme',
                'headers',
              ])
                delete body[field]
            }
            if (!isEdit) {
              body.api_key_entries = api_key ? [{ api_key }] : []
              body.proxy_id = newProxyId
            }
            save.mutate(body)
          }}
        >
          {isEdit ? t('apiEndpoints:save') : t('apiEndpoints:add')}
        </Button>
      </DialogFooter>
    </>
  )
}

function KeyRow({
  entry,
  busy,
  proxyLocked,
  canTest,
  testing,
  result,
  onProxyChange,
  onTest,
  onRemove,
}: {
  entry: ApiKeyEntry
  busy: boolean
  proxyLocked: boolean
  canTest: boolean
  testing: boolean
  result?: KeyTestResult
  onProxyChange: (proxyId: string) => void
  onTest: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('apiEndpoints')

  const cooldown = cooldownLabel(entry.cooldown_until)
  const proxyId =
    entry.proxy_id || (entry.has_proxy ? PROXY_SAVED : PROXY_DIRECT)
  return (
    <div className='space-y-2 px-3 py-2.5'>
      <div className='grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <span className='truncate font-mono text-sm'>
            {entry.api_key ||
              (entry.key_suffix ? `••••${entry.key_suffix}` : '••••••••')}
          </span>
          {entry.disabled ? (
            <span className='rounded-sm bg-muted px-1.5 text-xs text-muted-foreground'>
              {t('apiEndpoints:disabled')}
            </span>
          ) : null}
          {cooldown ? (
            <span className='rounded-sm bg-muted px-1.5 text-xs text-muted-foreground'>
              {cooldown}
            </span>
          ) : null}
        </div>
        <ProxyPicker
          value={proxyId}
          onChange={onProxyChange}
          disabled={busy || proxyLocked}
          ariaLabel={t('apiEndpoints:proxy')}
        />
        <div className='flex gap-2'>
          {canTest ? (
            <Button
              type='button'
              variant='outline'
              disabled={busy || testing}
              loading={testing}
              onClick={onTest}
            >
              {t('apiEndpoints:test')}
            </Button>
          ) : null}
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='text-muted-foreground hover:text-destructive'
            disabled={busy}
            onClick={onRemove}
            aria-label={t('apiEndpoints:remove')}
            title={t('apiEndpoints:remove')}
          >
            <Trash2 className='size-4' />
          </Button>
        </div>
      </div>
      {result ? <TestResultLine result={result} /> : null}
    </div>
  )
}

function TestResultLine({ result }: { result: KeyTestResult }) {
  const { t } = useTranslation('apiEndpoints')
  const detail = result.ok ? result.text : result.error
  return (
    <p
      className={cn(
        'text-xs break-words whitespace-pre-wrap',
        result.ok ? 'text-muted-foreground' : 'text-destructive'
      )}
    >
      {t('apiEndpoints:testSummary', {
        availability: result.ok
          ? t('apiEndpoints:available')
          : t('apiEndpoints:unavailable'),
        status: result.status || 0,
        route: result.proxy
          ? t('apiEndpoints:viaProxy')
          : t('apiEndpoints:direct'),
      })}
      {detail ? ` — ${detail}` : ''}
    </p>
  )
}

function ModelRow({
  row,
  onChange,
  onRemove,
}: {
  row: ModelDraft
  onChange: (next: Partial<ModelDraft>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('apiEndpoints')

  return (
    <div
      className={cn(
        MODEL_GRID,
        'grid-cols-[minmax(0,1fr)_auto] max-sm:rounded-md max-sm:border max-sm:p-2'
      )}
    >
      <Input
        className='max-sm:col-span-2'
        placeholder={t('apiEndpoints:upstreamModel')}
        aria-label={t('apiEndpoints:upstreamModel')}
        value={row.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <Input
        className='max-sm:col-span-2'
        placeholder={t('apiEndpoints:aliasPlaceholder')}
        aria-label={t('apiEndpoints:alias')}
        value={row.alias}
        onChange={(e) => onChange({ alias: e.target.value })}
      />
      <label className='flex items-center gap-1.5 text-sm sm:justify-center'>
        <Checkbox
          checked={row.image}
          onCheckedChange={(value) => onChange({ image: value === true })}
          aria-label={t('apiEndpoints:imageCapability')}
        />
        <span className='sm:sr-only'>{t('apiEndpoints:imageCapability')}</span>
      </label>
      <Input
        className='max-sm:col-span-2'
        placeholder={t('apiEndpoints:thinkingPlaceholder')}
        aria-label={t('apiEndpoints:thinkingLevels')}
        value={row.thinking}
        onChange={(e) => onChange({ thinking: e.target.value })}
      />
      <Button
        type='button'
        size='icon'
        variant='ghost'
        className='text-muted-foreground hover:text-destructive max-sm:col-start-2 max-sm:row-start-3'
        onClick={onRemove}
        aria-label={t('apiEndpoints:remove')}
        title={t('apiEndpoints:remove')}
      >
        <Trash2 className='size-4' />
      </Button>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  useTranslation('apiEndpoints')

  return (
    <div className='space-y-1'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

/** 官方预设联动（地址/协议随类型自动填充），custom 兜底为空地址 + anthropic。 */
function presetFor(
  presets: ApiEndpointPreset[],
  kind: string
): { kind: string; label: string; base_url: string; protocol: string } {
  const found = presets.find((p) => p.kind === kind)
  if (found)
    return {
      ...found,
      label:
        kind === 'claude' || kind === 'openai' || kind === 'custom'
          ? t(KIND_LABEL_KEYS[kind])
          : found.label,
    }
  if (kind === 'custom')
    return {
      kind: 'custom',
      label: t('apiEndpoints:custom'),
      base_url: '',
      protocol: 'anthropic',
    }
  if (kind === 'openai')
    return {
      kind: 'openai',
      label: t('apiEndpoints:openaiOfficial'),
      base_url: 'https://api.openai.com',
      protocol: 'openai',
    }
  return {
    kind: 'claude',
    label: t('apiEndpoints:claudeOfficial'),
    base_url: 'https://api.anthropic.com',
    protocol: 'anthropic',
  }
}

function modelsFromEndpoint(endpoint: ApiEndpoint | null): ModelDraft[] {
  const models = endpoint?.models || []
  if (!models.length)
    return [{ name: '', alias: '', image: false, thinking: '' }]
  return models.map((model) => ({
    name: model.name || '',
    alias: model.alias || '',
    image: !!model.image,
    thinking: (model.thinking?.levels || []).join(','),
  }))
}

function collectModels(rows: ModelDraft[]): ApiModelEntry[] {
  const out: ApiModelEntry[] = []
  for (const row of rows) {
    const name = row.name.trim()
    const alias = row.alias.trim() || name
    if (!name || !alias) continue
    const levels = row.thinking.split(/[,\s]+/).filter(Boolean)
    const entry: ApiModelEntry = { name, alias }
    if (row.image) entry.image = true
    if (levels.length) entry.thinking = { levels }
    out.push(entry)
  }
  return out
}

function parseHeadersJson(raw: string): Record<string, string> | null {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    return parsed as Record<string, string>
  } catch {
    return null
  }
}

function withoutResult(
  results: Record<string, KeyTestResult>,
  slot: string
): Record<string, KeyTestResult> {
  const next = { ...results }
  delete next[slot]
  return next
}

function cooldownLabel(until?: number): string | null {
  if (!until) return null
  const formatted = fmtExpiresAt(until)
  if (!formatted || formatted === '—') return t('apiEndpoints:cooling')
  return t('apiEndpoints:coolingUntil', { when: formatted })
}

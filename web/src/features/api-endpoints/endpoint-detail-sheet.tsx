import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type {
  ApiEndpoint,
  ApiEndpointPreset,
  ApiKeyEntry,
  ApiModelEntry,
} from '@/types/panel-api-endpoints'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'

type EndpointKind = 'claude' | 'openai' | 'custom'
type Protocol = 'anthropic' | 'openai'
type EpAuthScheme = 'x_api_key' | 'authorization_bearer'

const KIND_LABEL_KEYS: Record<EndpointKind, string> = {
  claude: 'apiEndpoints:claudeOfficial',
  openai: 'apiEndpoints:openaiOfficial',
  custom: 'apiEndpoints:custom',
}

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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='w-[95vw] overflow-y-auto sm:w-[560px] sm:max-w-none md:w-[720px] lg:w-[820px]'
      >
        {open ? (
          <EndpointForm
            key={endpoint?.id ?? 'create'}
            endpoint={endpoint}
            presets={presets}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </SheetContent>
    </Sheet>
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
    endpoint?.auth_scheme || 'x_api_key'
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
  const [newKey, setNewKey] = useState('')
  const [newProxy, setNewProxy] = useState('')
  const keys = endpoint?.api_key_entries || []

  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiEndpointsQueryOptions().queryKey })

  const applyKind = (nextKind: EndpointKind) => {
    const nextPreset = presetFor(presets, nextKind)
    setKind(nextKind)
    if (nextKind !== 'custom') {
      setBaseUrl(nextPreset.base_url)
      setProtocol((nextPreset.protocol as Protocol) || 'anthropic')
    }
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
              proxy_url: newProxy.trim(),
              auth_scheme: authScheme,
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

  const addKey = useMutation({
    mutationFn: (body: { api_key: string; proxy_url: string }) => {
      if (!endpoint) throw new Error(t('apiEndpoints:addressNotFound'))
      return api(
        `/api/panel/api-endpoints/${encodeURIComponent(endpoint.id)}/keys`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      )
    },
    onSuccess: async () => {
      toast.success(t('apiEndpoints:keyAdded'))
      setNewKey('')
      setNewProxy('')
      await refresh()
    },
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

  const pending = save.isPending || addKey.isPending || removeKey.isPending

  return (
    <>
      <SheetHeader className='pb-2'>
        <SheetTitle>
          {isEdit
            ? t('apiEndpoints:editAddress')
            : t('apiEndpoints:addAddress')}
        </SheetTitle>
        <SheetDescription>
          {isEdit
            ? endpoint?.name || endpoint?.id
            : t('apiEndpoints:detailDescription')}
        </SheetDescription>
      </SheetHeader>
      <div className='space-y-6 pb-8'>
        <section className='space-y-3'>
          <h3 className='text-sm font-medium'>{t('apiEndpoints:basicInfo')}</h3>
          <Field label={t('apiEndpoints:kind')}>
            <Select
              disabled={endpoint?.connection_editable === false}
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
            <Field label={t('apiEndpoints:address')}>
              <Input
                disabled={endpoint?.connection_editable === false}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder='https://api.example.com'
              />
            </Field>
          ) : null}
          {kind === 'custom' ? (
            <Field label={t('apiEndpoints:protocol')}>
              <Select
                disabled={endpoint?.connection_editable === false}
                value={protocol}
                onValueChange={(value) => setProtocol(value as Protocol)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='anthropic'>Anthropic Messages</SelectItem>
                  <SelectItem value='openai'>OpenAI Chat</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
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
          <Field label={t('apiEndpoints:upstreamAuth')}>
            <Select
              disabled={endpoint?.connection_editable === false}
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
          <div className='flex items-center justify-between gap-3'>
            <Label htmlFor='disable_cooling'>
              {t('apiEndpoints:disable429Cooling')}
            </Label>
            <Switch
              id='disable_cooling'
              checked={disableCooling}
              onCheckedChange={setDisableCooling}
            />
          </div>
          <Field label={t('apiEndpoints:headersJson')}>
            <Textarea
              className='font-mono text-xs'
              rows={4}
              disabled={endpoint?.connection_editable === false}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder='{"anthropic-beta":"…"}'
            />
          </Field>
        </section>

        <section className='space-y-3'>
          <h3 className='text-sm font-medium'>
            {t('apiEndpoints:upstreamKey')}
          </h3>
          {isEdit ? (
            keys.length ? (
              <div className='space-y-2'>
                {keys.map((entry) => (
                  <KeyRow
                    key={entry.id}
                    entry={entry}
                    busy={pending}
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
          <div className='grid gap-2 sm:grid-cols-2'>
            <Field
              label={
                isEdit
                  ? t('apiEndpoints:newKey')
                  : t('apiEndpoints:upstreamKey')
              }
            >
              <Input
                id='api_key'
                name='api_key'
                type='password'
                autoComplete='off'
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder='sk-…'
              />
            </Field>
            <Field label={t('apiEndpoints:proxy')}>
              <Input
                value={newProxy}
                onChange={(e) => setNewProxy(e.target.value)}
                placeholder={t('apiEndpoints:proxyPlaceholder')}
              />
            </Field>
          </div>
          {isEdit ? (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={pending}
              onClick={() => {
                const api_key = newKey.trim()
                if (!api_key) {
                  toast.error(t('apiEndpoints:keyRequired'))
                  return
                }
                addKey.mutate({ api_key, proxy_url: newProxy.trim() })
              }}
            >
              {t('apiEndpoints:addKey')}
            </Button>
          ) : (
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={fetchModels.isPending}
              loading={fetchModels.isPending}
              onClick={() => fetchModels.mutate()}
            >
              {t('apiEndpoints:fetchModels')}
            </Button>
          )}
        </section>

        <section className='space-y-3'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-sm font-medium'>{t('apiEndpoints:models')}</h3>
            <div className='flex items-center gap-2'>
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
                variant='ghost'
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
      </div>
      {endpoint?.connection_editable === false && (
        <p className='px-4 text-sm text-muted-foreground'>
          {t('apiEndpoints:connectionAdminOnly')}
        </p>
      )}
      <SheetFooter>
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
              auth_scheme: authScheme,
              headers,
              models: collectModels(models),
            }
            if (isEdit && endpoint?.connection_editable === false) {
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
              body.api_key_entries = api_key
                ? [{ api_key, proxy_url: newProxy.trim() }]
                : []
            }
            save.mutate(body)
          }}
        >
          {isEdit ? t('apiEndpoints:save') : t('apiEndpoints:add')}
        </Button>
      </SheetFooter>
    </>
  )
}

function KeyRow({
  entry,
  busy,
  onRemove,
}: {
  entry: ApiKeyEntry
  busy: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation('apiEndpoints')

  const cooldown = cooldownLabel(entry.cooldown_until)
  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border px-3 py-2'>
      <span className='font-mono text-xs'>{entry.id}</span>
      <span className='font-mono text-xs text-muted-foreground'>
        {entry.api_key ||
          (entry.key_suffix ? `••••${entry.key_suffix}` : '••••••••')}
      </span>
      {entry.disabled ? (
        <span className='text-xs text-muted-foreground'>
          {t('apiEndpoints:disable')}
        </span>
      ) : null}
      {cooldown ? (
        <span className='text-xs text-muted-foreground'>{cooldown}</span>
      ) : null}
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='ms-auto'
        disabled={busy}
        onClick={onRemove}
      >
        {t('apiEndpoints:remove')}
      </Button>
    </div>
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
    <div className='flex flex-wrap items-center gap-2'>
      <Input
        className='min-w-[8rem] flex-1'
        placeholder={t('apiEndpoints:upstreamName')}
        value={row.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <Input
        className='min-w-[8rem] flex-1'
        placeholder={t('apiEndpoints:alias')}
        value={row.alias}
        onChange={(e) => onChange({ alias: e.target.value })}
      />
      <label className='flex items-center gap-1.5 text-sm'>
        <Checkbox
          checked={row.image}
          onCheckedChange={(value) => onChange({ image: value === true })}
        />
        {t('apiEndpoints:imageCapability')}
      </label>
      <Input
        className='min-w-[10rem] flex-1'
        placeholder={t('apiEndpoints:thinkingLevels')}
        value={row.thinking}
        onChange={(e) => onChange({ thinking: e.target.value })}
      />
      <Button type='button' size='sm' variant='ghost' onClick={onRemove}>
        {t('apiEndpoints:remove')}
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

function cooldownLabel(until?: number): string | null {
  if (!until) return null
  const formatted = fmtExpiresAt(until)
  if (!formatted || formatted === '—') return t('apiEndpoints:cooling')
  return t('apiEndpoints:coolingUntil', { when: formatted })
}

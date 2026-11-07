import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t } from '@/i18n'
import type {
  JevEndpointKey,
  JevInterceptConfig,
  PolicyQuestion,
} from '@/types/panel-routing'
import type { StatusTone } from '@/types/status'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { StatusMark } from '@/components/status-mark'
import { SaveBar } from '@/features/settings/save-bar'
import { FieldLine, Group, ToggleItem, ToggleList } from './blocks'
import { jevInterceptQueryOptions } from './queries'
import { QuestionBank } from './question-bank'

const KEY_MAX = 999
const EXAMPLES = [
  { id: 'typesafe', label: 'TypeSafe', base_url: 'https://api.typesafe.ai' },
  { id: 'laya', label: 'Laya', base_url: 'http://127.0.0.1:8000' },
  { id: 'modernbert', label: 'ModernBERT', base_url: 'http://127.0.0.1:8000' },
] as const

const KEY_STATUS: Record<string, StatusTone> = {
  normal: {
    key: 'ok',
    cls: 'ok',
    get text() {
      return t('risk:keyStatusNormal')
    },
  },
  unrequested: {
    key: 'none',
    cls: 'none',
    get text() {
      return t('risk:keyStatusUnrequested')
    },
  },
  paused: {
    key: 'off',
    cls: 'off',
    get text() {
      return t('risk:keyStatusPaused')
    },
  },
  auth_error: {
    key: 'bad',
    cls: 'bad',
    get text() {
      return t('risk:keyStatusAuthError')
    },
  },
  insufficient_balance: {
    key: 'bad',
    cls: 'bad',
    get text() {
      return t('risk:keyStatusInsufficientBalance')
    },
  },
  rate_limited: {
    key: 'warn',
    cls: 'warn',
    get text() {
      return t('risk:keyStatusRateLimited')
    },
  },
  request_error: {
    key: 'caution',
    cls: 'caution',
    get text() {
      return t('risk:keyStatusRequestError')
    },
  },
  unsupported: {
    key: 'caution',
    cls: 'caution',
    get text() {
      return t('risk:keyStatusUnsupported')
    },
  },
}

/** Fields this stage owns. Hard-regex fields on the same config stay untouched. */
const OWNED = [
  'enabled',
  'provider',
  'base_url',
  'model',
  'timeout_ms',
  'safety_instruction',
  'safety_threshold',
  'block_if_below',
  'fail_open',
  'dedup_sec',
  'max_state_chars',
] as const

type EndpointForm = {
  uid: string
  base_url: string
  from_base_url: string
  keys: string[]
  expanded: boolean
  clearSaved: boolean
}

type ProbeRow = {
  masked_key: string
  key_fingerprint: string
  available: boolean
  baseline_ok: boolean | null
  http_status: number | null
  safe_score: number | null
  unsafe_score: number | null
  message: string
}

type QuotaRow = {
  masked_key: string
  key_fingerprint: string
  status: string
  remaining: number | null
  unit: string | null
  message: string
}

type CheckState = { ok: boolean; text: string }

function ownedOf(data: JevInterceptConfig) {
  return JSON.stringify([
    ...OWNED.map((key) => data[key] ?? null),
    data.question_bank || [],
  ])
}

function asDraft(data: JevInterceptConfig) {
  return data
}

function ownedDiffers(a: JevInterceptConfig, b: JevInterceptConfig) {
  return ownedOf(a) !== ownedOf(b)
}

function decisionKey(base: string) {
  const text = base.trim().replace(/\/+$/, '')
  if (!text) return ''
  if (/\/(systemone|decide)$/i.test(text)) return text.toLowerCase()
  if (/\/v1$/i.test(text)) return `${text}/systemone`.toLowerCase()
  return `${text}/v1/systemone`.toLowerCase()
}

function isTypeSafe(base: string) {
  try {
    return new URL(base.trim()).hostname === 'api.typesafe.ai'
  } catch {
    return false
  }
}

function providerFor(
  base: string,
  model: string,
  previous: JevInterceptConfig['provider']
): JevInterceptConfig['provider'] {
  if (isTypeSafe(base)) return 'jev'
  if (model.trim() === 'english') return 'modernbert'
  if (
    !model.trim() &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base.trim())
  )
    return 'laya'
  return previous || 'jev'
}

function savedBases(data: JevInterceptConfig) {
  const rows = (data.endpoints || []).filter((endpoint) => endpoint.base_url)
  if (rows.length) return rows.map((endpoint) => endpoint.base_url)
  return [data.base_url || '']
}

function formsFrom(data: JevInterceptConfig): EndpointForm[] {
  return savedBases(data).map((base, index) => ({
    uid: `saved:${index}:${base}`,
    base_url: base,
    from_base_url: base,
    keys: [''],
    expanded: false,
    clearSaved: false,
  }))
}

function endpointsDirty(
  forms: EndpointForm[] | null,
  data: JevInterceptConfig
) {
  if (!forms) return false
  const current = forms.map((form) => form.base_url.trim())
  if (savedBases(data).join('\n') !== current.join('\n')) return true
  return forms.some(
    (form) => form.clearSaved || form.keys.some((key) => key.trim())
  )
}

function blankForm(base = ''): EndpointForm {
  return {
    uid: `custom:${crypto.randomUUID()}`,
    base_url: base,
    from_base_url: '',
    keys: [''],
    expanded: true,
    clearSaved: false,
  }
}

function toneOf(status: string | undefined): StatusTone {
  return KEY_STATUS[status || ''] || KEY_STATUS.request_error
}

function scoreOf(value: number | null) {
  return value == null ? '—' : value.toFixed(2)
}

function probeStatus(row: ProbeRow) {
  if (row.http_status === 401 || row.http_status === 403) return 'auth_error'
  if (row.http_status === 402) return 'insufficient_balance'
  if (row.http_status === 429 || row.http_status === 529) return 'rate_limited'
  if (row.baseline_ok === false || !row.available) return 'request_error'
  return 'normal'
}

/** Decision model: connection, scoring and the question bank, saved together. */
export function ModelSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  // 只同步本块字段：别的块保存会改写同一份缓存，本块有未保存改动时保留草稿。
  const [draft, setDraft] = useServerDraft(q.data, asDraft, ownedDiffers)
  const [forms, setForms] = useState<EndpointForm[] | null>(null)
  const [synced, setSynced] = useState('')
  const [listed, setListed] = useState<string[]>([])
  const [live, setLive] = useState<Record<string, string>>({})
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [pending, setPending] = useState<
    Record<string, 'probe' | 'quota' | ''>
  >({})

  const savedSig = (q.data ? savedBases(q.data) : []).join('\n')
  const dirty =
    !!draft &&
    !!q.data &&
    (ownedOf(draft) !== ownedOf(q.data) || endpointsDirty(forms, q.data))

  useEffect(() => {
    if (!q.data || dirty) return
    if (forms && synced === savedSig) return
    setForms(formsFrom(q.data))
    setSynced(savedSig)
  }, [q.data, dirty, forms, savedSig, synced])

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const load = (data: JevInterceptConfig) => {
    setDraft(data)
    setForms(formsFrom(data))
    setSynced(savedBases(data).join('\n'))
    setLive({})
    setChecks({})
  }

  const patchForm = (uid: string, patch: Partial<EndpointForm>) =>
    setForms(
      (prev) =>
        prev?.map((form) =>
          form.uid === uid ? { ...form, ...patch } : form
        ) || prev
    )

  const save = useMutation({
    mutationFn: () => {
      if (!draft || !forms) throw new Error(translate('risk:noConfigToSave'))
      const filled = forms.filter((form) => form.base_url.trim())
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        model: draft.model,
        timeout_ms: Number(draft.timeout_ms),
        safety_instruction: draft.safety_instruction || '',
        safety_threshold: Number(draft.safety_threshold ?? 0.5),
        block_if_below: draft.block_if_below !== false,
        fail_open: draft.fail_open !== false,
        dedup_sec: Number(draft.dedup_sec ?? 60),
        max_state_chars: Number(draft.max_state_chars ?? 16000),
        questions: draft.question_bank || [],
      }
      if (!filled.length) {
        body.base_url = ''
        body.api_keys = []
        body.provider = 'jev'
      } else {
        body.base_url = filled[0].base_url.trim()
        body.provider = providerFor(
          filled[0].base_url,
          draft.model,
          draft.provider || 'jev'
        )
        body.endpoints = filled.map((form) => {
          const typed = form.keys.map((key) => key.trim()).filter(Boolean)
          const row: Record<string, unknown> = {
            base_url: form.base_url.trim(),
          }
          if (form.from_base_url) row.from_base_url = form.from_base_url
          if (form.clearSaved) {
            row.api_keys = typed
            row.append = false
          } else if (typed.length) {
            row.api_keys = typed
            row.append = true
          }
          return row
        })
      }
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: (data) => {
      toast.success(translate('risk:decisionModelSaved'))
      load(data)
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const runCheck = async (form: EndpointForm, kind: 'probe' | 'quota') => {
    if (!draft) return
    const base = form.base_url.trim()
    if (!base) {
      toast.error(translate('risk:modelUrlRequired'))
      return
    }
    setPending((prev) => ({ ...prev, [form.uid]: kind }))
    try {
      const typed = form.keys.map((key) => key.trim()).filter(Boolean)
      const path =
        kind === 'probe'
          ? '/api/panel/jev-intercept/probe'
          : '/api/panel/jev-intercept/quota'
      const data = await api<{
        results: Array<ProbeRow | QuotaRow>
        omitted: number
      }>(path, {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_keys: typed,
          model: draft.model,
          timeout_ms: Number(draft.timeout_ms) || 2000,
        }),
      })
      const results = data.results || []
      const omitted = data.omitted
        ? `\n${translate('risk:keysNotTested', { count: data.omitted })}`
        : ''
      if (kind === 'probe') {
        const rows = results as ProbeRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (row.key_fingerprint)
              next[row.key_fingerprint] = probeStatus(row)
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.baseline_ok === true)
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || translate('risk:noKey')
                  const scores =
                    row.safe_score == null && row.unsafe_score == null
                      ? ''
                      : translate('risk:probeScores', {
                          safe: scoreOf(row.safe_score),
                          unsafe: scoreOf(row.unsafe_score),
                        })
                  return translate('risk:probeResultLine', {
                    name,
                    message: row.message,
                    scores,
                  })
                })
                .join('\n') + omitted,
          },
        }))
      } else {
        const rows = results as QuotaRow[]
        setLive((prev) => {
          const next = { ...prev }
          for (const row of rows) {
            if (
              row.key_fingerprint &&
              (row.status === 'auth_error' ||
                row.status === 'insufficient_balance')
            )
              next[row.key_fingerprint] = row.status
          }
          return next
        })
        const ok =
          rows.length > 0 && rows.every((row) => row.status === 'normal')
        setChecks((prev) => ({
          ...prev,
          [form.uid]: {
            ok,
            text:
              rows
                .map((row) => {
                  const name = row.masked_key || translate('risk:noKey')
                  const money =
                    row.remaining == null
                      ? row.message
                      : translate('risk:quotaRemaining', {
                          amount: `${row.remaining}${row.unit ? ` ${row.unit}` : ''}`,
                        })
                  return translate('risk:probeResultLine', {
                    name,
                    message: money,
                    scores: '',
                  })
                })
                .join('\n') + omitted,
          },
        }))
      }
      void qc.invalidateQueries({ queryKey: ['panel', 'jev-usage'] })
      if (kind === 'probe')
        void qc.invalidateQueries({
          queryKey: jevInterceptQueryOptions().queryKey,
        })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : translate('risk:testFailed')
      setChecks((prev) => ({
        ...prev,
        [form.uid]: { ok: false, text: message },
      }))
      toast.error(message)
    } finally {
      setPending((prev) => ({ ...prev, [form.uid]: '' }))
    }
  }

  const fetchModels = useMutation({
    mutationFn: () => {
      const base = forms?.[0]?.base_url.trim() || ''
      if (!base) throw new Error(translate('risk:modelUrlRequired'))
      const typed =
        forms?.[0]?.keys.map((key) => key.trim()).find(Boolean) || ''
      return api<{ models: string[] }>('/api/panel/jev-intercept/models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: base,
          api_key: typed,
          timeout_ms: Number(draft?.timeout_ms) || 2000,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = data.models || []
      setListed(ids)
      setDraft((prev) => {
        if (!prev || prev.model.trim()) return prev
        const pick = (ids.includes('jev-latest') ? 'jev-latest' : ids[0]) || ''
        return pick ? { ...prev, model: pick } : prev
      })
      toast.success(
        ids.length
          ? translate('risk:modelsFetched', { count: ids.length })
          : translate('risk:noModelsReturned')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const addExample = (base: string) => {
    setForms((prev) => {
      if (!prev) return prev
      const key = decisionKey(base)
      if (key && prev.some((form) => decisionKey(form.base_url) === key)) {
        toast.message(translate('risk:addressAlreadyListed'))
        return prev
      }
      if (
        prev.length === 1 &&
        !prev[0].base_url.trim() &&
        !prev[0].from_base_url
      )
        return [{ ...prev[0], base_url: base }]
      return [...prev, blankForm(base)]
    })
  }

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft || !forms)
    return <div className='h-40 animate-pulse bg-muted/40' />

  const restoreScore = () => {
    const defaults = draft.defaults
    setDraft({
      ...draft,
      safety_instruction: '',
      safety_threshold: defaults?.safety_threshold ?? 0.5,
      block_if_below: defaults?.block_if_below !== false,
      fail_open: defaults?.fail_open !== false,
      dedup_sec: defaults?.dedup_sec ?? 60,
      max_state_chars: defaults?.max_state_chars ?? 16000,
    })
  }
  const questions = draft.question_bank || []
  const setQuestions = (rows: PolicyQuestion[]) =>
    setDraft({ ...draft, question_bank: rows })
  const enabledQuestions = questions.filter((row) => row.enabled).length
  const modelPlaceholder = isTypeSafe(forms[0]?.base_url || '')
    ? /* i18n-exempt "jev-latest" -- Example model ID; the API identifier must be preserved. */ 'jev-latest'
    : translate('risk:modelEmptyHint')

  return (
    <div className='space-y-8 p-4'>
      <Group
        title={translate('risk:whenToBlock')}
        hint={translate('risk:decisionModelDescription')}
      >
        <ToggleList>
          <ToggleItem
            label={translate('risk:decisionModel')}
            desc={translate('risk:scoreAllQuestionsHint')}
          >
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:failOpen')}
            desc={translate('risk:failOpenSettingHint')}
          >
            <Switch
              checked={draft.fail_open !== false}
              onCheckedChange={(v) => setDraft({ ...draft, fail_open: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:blockBelowThreshold')}
            desc={translate('risk:blockThresholdHint')}
          >
            <Switch
              checked={draft.block_if_below !== false}
              onCheckedChange={(v) => setDraft({ ...draft, block_if_below: v })}
            />
          </ToggleItem>
        </ToggleList>
      </Group>

      <Group
        title={translate('risk:connection')}
        hint={translate('risk:connectionByAddressHint')}
      >
        <div className='space-y-4'>
          {forms.map((form, index) => {
            const saved = (q.data?.endpoints || []).find(
              (endpoint) => endpoint.base_url === form.from_base_url
            )?.keys
            const savedKeys = saved || []
            const shownSaved = form.expanded ? savedKeys : savedKeys.slice(0, 1)
            const hidden = form.expanded ? [] : savedKeys.slice(1)
            const hiddenSummary = hidden
              .map(
                (row) => toneOf(live[row.key_fingerprint] || row.status).text
              )
              .join(translate('risk:listSeparator'))
            const adding = savedKeys.length > 0
            const extra = adding ? form.keys : form.keys.slice(1)
            const check = checks[form.uid]
            return (
              <div key={form.uid} className='space-y-3 rounded-xl border p-4'>
                <FieldLine
                  label={translate('risk:url')}
                  htmlFor={`jev-base-${form.uid}`}
                >
                  <div className='flex flex-wrap gap-2'>
                    <Input
                      id={`jev-base-${form.uid}`}
                      className='min-w-48 flex-1 font-mono'
                      value={form.base_url}
                      placeholder='https://api.typesafe.ai'
                      onChange={(e) =>
                        patchForm(form.uid, { base_url: e.target.value })
                      }
                    />
                    {index === 0 ? (
                      <Button
                        type='button'
                        variant='outline'
                        className='shrink-0 cursor-pointer'
                        onClick={() =>
                          patchForm(form.uid, {
                            base_url: 'https://api.typesafe.ai',
                          })
                        }
                      >
                        {translate('risk:default')}
                      </Button>
                    ) : null}
                    {forms.length > 1 ? (
                      <Button
                        type='button'
                        variant='ghost'
                        className='shrink-0 cursor-pointer'
                        onClick={() =>
                          setForms((prev) =>
                            prev
                              ? prev.filter((item) => item.uid !== form.uid)
                              : prev
                          )
                        }
                      >
                        {translate('risk:remove')}
                      </Button>
                    ) : null}
                  </div>
                </FieldLine>
                <FieldLine
                  label={translate('risk:key')}
                  htmlFor={`jev-key-${form.uid}`}
                >
                  <div className='space-y-2'>
                    <div className='flex flex-wrap gap-2'>
                      {adding ? (
                        <SavedKey
                          row={shownSaved[0]}
                          live={live}
                          placeholder={translate('risk:noKeysYet')}
                        />
                      ) : (
                        <Input
                          id={`jev-key-${form.uid}`}
                          type='password'
                          autoComplete='off'
                          className='min-w-40 flex-1'
                          value={form.keys[0] || ''}
                          placeholder={translate('risk:localServiceKeyHint')}
                          onChange={(e) =>
                            patchForm(form.uid, {
                              keys: form.keys.map((key, i) =>
                                i === 0 ? e.target.value : key
                              ),
                              clearSaved: e.target.value
                                ? false
                                : form.clearSaved,
                            })
                          }
                        />
                      )}
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        aria-expanded={form.expanded}
                        onClick={() =>
                          patchForm(form.uid, { expanded: !form.expanded })
                        }
                      >
                        {form.expanded
                          ? translate('risk:collapse')
                          : translate('risk:expandMore')}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        loading={pending[form.uid] === 'probe'}
                        disabled={!!pending[form.uid]}
                        onClick={() => void runCheck(form, 'probe')}
                      >
                        {translate('risk:oneClickTest')}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        className='cursor-pointer'
                        loading={pending[form.uid] === 'quota'}
                        disabled={!!pending[form.uid]}
                        onClick={() => void runCheck(form, 'quota')}
                      >
                        {translate('risk:checkRemainingQuota')}
                      </Button>
                    </div>
                    {shownSaved.length ? (
                      <KeyList rows={shownSaved} live={live} />
                    ) : null}
                    {form.expanded ? (
                      <div className='space-y-2 border-t pt-2'>
                        {extra.map((value, keyIndex) => {
                          const realIndex = adding ? keyIndex : keyIndex + 1
                          return (
                            <div key={realIndex} className='flex gap-2'>
                              <Input
                                type='password'
                                autoComplete='off'
                                aria-label={translate(
                                  'risk:additionalKeyNumber',
                                  {
                                    number: realIndex + 1,
                                  }
                                )}
                                value={value}
                                placeholder={translate('risk:addAnotherKey')}
                                onChange={(e) =>
                                  patchForm(form.uid, {
                                    keys: form.keys.map((key, i) =>
                                      i === realIndex ? e.target.value : key
                                    ),
                                  })
                                }
                              />
                              <Button
                                type='button'
                                variant='ghost'
                                className='cursor-pointer'
                                onClick={() =>
                                  patchForm(form.uid, {
                                    keys: form.keys.filter(
                                      (_, i) => i !== realIndex
                                    ),
                                  })
                                }
                              >
                                {translate('risk:delete')}
                              </Button>
                            </div>
                          )
                        })}
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='cursor-pointer'
                            disabled={form.keys.length >= KEY_MAX}
                            onClick={() =>
                              patchForm(form.uid, { keys: [...form.keys, ''] })
                            }
                          >
                            {translate('risk:addOneMoreKey')}
                          </Button>
                          {savedKeys.length ? (
                            <ToggleItem
                              label={translate('risk:clearSavedKeys')}
                              desc={translate('risk:replaceSavedKeysHint')}
                            >
                              <Switch
                                checked={form.clearSaved}
                                onCheckedChange={(v) =>
                                  patchForm(form.uid, { clearSaved: v })
                                }
                              />
                            </ToggleItem>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {check ? (
                      <p
                        className={cn(
                          'text-xs whitespace-pre-wrap',
                          check.ok ? 'text-foreground' : 'text-destructive'
                        )}
                        role={check.ok ? undefined : 'alert'}
                      >
                        {check.text}
                      </p>
                    ) : (
                      <p className='text-xs text-muted-foreground'>
                        {savedKeys.length
                          ? hiddenSummary
                            ? translate('risk:savedKeysSummaryHidden', {
                                count: savedKeys.length,
                                hidden: hiddenSummary,
                              })
                            : translate('risk:savedKeysSummary', {
                                count: savedKeys.length,
                              })
                          : translate('risk:noKeysYetSentence')}{' '}
                        {translate('risk:probeHelp')}
                      </p>
                    )}
                  </div>
                </FieldLine>
              </div>
            )
          })}
          <div className='flex flex-wrap gap-2'>
            {EXAMPLES.map((example) => (
              <Button
                key={example.id}
                type='button'
                variant='outline'
                size='sm'
                className='cursor-pointer'
                onClick={() => addExample(example.base_url)}
              >
                {translate('risk:addExample', { label: example.label })}
              </Button>
            ))}
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='cursor-pointer'
              onClick={() =>
                setForms((prev) => (prev ? [...prev, blankForm()] : prev))
              }
            >
              {translate('risk:addCustomAddress')}
            </Button>
          </div>
          <p className='text-xs text-muted-foreground'>
            {translate('risk:exampleAddressesHint')}
          </p>
        </div>
        <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]'>
          <FieldLine label={translate('risk:model')} htmlFor='jev-model'>
            <div className='flex gap-2'>
              <Input
                id='jev-model'
                className='font-mono'
                value={draft.model}
                placeholder={modelPlaceholder}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
              <Button
                type='button'
                variant='outline'
                className='shrink-0 cursor-pointer'
                loading={fetchModels.isPending}
                disabled={fetchModels.isPending || !forms[0]?.base_url.trim()}
                onClick={() => fetchModels.mutate()}
              >
                {translate('risk:fetchModels')}
              </Button>
            </div>
          </FieldLine>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-timeout'>
              {translate('risk:timeoutMilliseconds')}
            </Label>
            <Input
              id='jev-timeout'
              type='number'
              min={200}
              max={8000}
              className='tabular-nums'
              value={draft.timeout_ms}
              onChange={(e) =>
                setDraft({ ...draft, timeout_ms: Number(e.target.value) })
              }
            />
          </div>
        </div>
        {listed.length ? (
          <div className='flex flex-wrap gap-1.5'>
            {listed.map((id) => (
              <button
                key={id}
                type='button'
                className={cn(
                  'cursor-pointer rounded-md px-2 py-1 font-mono text-xs transition-colors duration-200',
                  draft.model === id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setDraft({ ...draft, model: id })}
              >
                {id}
              </button>
            ))}
          </div>
        ) : null}
      </Group>

      <Group
        title={translate('risk:scoring')}
        hint={translate('risk:scoringHint')}
        action={
          <button
            type='button'
            className='cursor-pointer text-xs text-muted-foreground underline-offset-4 transition-colors duration-200 hover:text-foreground hover:underline'
            onClick={restoreScore}
          >
            {translate('risk:restoreDefaults')}
          </button>
        }
      >
        <div className='grid gap-3 sm:grid-cols-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-threshold'>{translate('risk:threshold')}</Label>
            <Input
              id='jev-threshold'
              type='number'
              min={0}
              max={1}
              step={0.05}
              className='tabular-nums'
              value={draft.safety_threshold ?? 0.5}
              onChange={(e) =>
                setDraft({ ...draft, safety_threshold: Number(e.target.value) })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-dedup'>
              {translate('risk:deduplicationSeconds')}
            </Label>
            <Input
              id='jev-dedup'
              type='number'
              min={0}
              max={3600}
              className='tabular-nums'
              value={draft.dedup_sec ?? 60}
              onChange={(e) =>
                setDraft({ ...draft, dedup_sec: Number(e.target.value) })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='jev-state'>
              {translate('risk:modelCharacterLimit')}
            </Label>
            <Input
              id='jev-state'
              type='number'
              min={256}
              max={64000}
              className='tabular-nums'
              value={draft.max_state_chars ?? 16000}
              onChange={(e) =>
                setDraft({ ...draft, max_state_chars: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='jev-instruction'>
            {translate('risk:customRequirement')}
          </Label>
          <Textarea
            id='jev-instruction'
            rows={2}
            value={draft.safety_instruction || ''}
            placeholder={translate('risk:customRequirementHint')}
            onChange={(e) =>
              setDraft({ ...draft, safety_instruction: e.target.value })
            }
          />
        </div>
      </Group>

      <Group
        title={translate('risk:questionBank')}
        hint={translate('risk:enabledQuestionsHint', {
          p0: enabledQuestions,
          p1: questions.length,
        })}
        action={
          <Button
            size='sm'
            variant='outline'
            className='cursor-pointer'
            onClick={() => setQuestions(q.data?.builtin_questions || [])}
          >
            {translate('risk:restoreBuiltIn')}
          </Button>
        }
      >
        <QuestionBank rows={questions} onChange={setQuestions} />
      </Group>

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => q.data && load(q.data)}
        />
      ) : null}
    </div>
  )
}

function SavedKey({
  row,
  live,
  placeholder,
}: {
  row: JevEndpointKey | undefined
  live: Record<string, string>
  placeholder: string
}) {
  if (!row) {
    return <span className='text-sm text-muted-foreground'>{placeholder}</span>
  }
  const status = live[row.key_fingerprint] || row.status
  return (
    <span className='flex min-w-40 flex-1 items-center gap-2'>
      <span className='font-mono text-sm'>{row.masked_key}</span>
      <StatusMark tone={toneOf(status)} />
    </span>
  )
}

function KeyList({
  rows,
  live,
}: {
  rows: JevEndpointKey[]
  live: Record<string, string>
}) {
  if (rows.length <= 1) return null
  return (
    <ul className='space-y-1'>
      {rows.slice(1).map((row) => (
        <li key={row.key_fingerprint || row.number}>
          <SavedKey row={row} live={live} placeholder='' />
        </li>
      ))}
    </ul>
  )
}

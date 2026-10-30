import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JevInterceptConfig, PolicyQuestion } from '@/types/panel-routing'
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
import { SaveBar } from '@/features/settings/save-bar'
import {
  FieldLine,
  Fold,
  FoldStack,
  Group,
  Segmented,
  ToggleItem,
  ToggleList,
} from './blocks'
import { jevInterceptQueryOptions } from './queries'
import { QuestionBank } from './question-bank'

function linesOf(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

const KEY_MAX = 999
const PROVIDERS = [
  {
    id: 'jev' as const,
    label: 'Jev',
    default_model: 'jev-latest',
    default_base_url: 'https://api.typesafe.ai',
  },
  {
    id: 'laya' as const,
    label: 'Laya',
    default_model: '',
    default_base_url: 'http://127.0.0.1:8000',
  },
  {
    id: 'modernbert' as const,
    label: 'ModernBERT',
    default_model: 'english',
    default_base_url: 'http://127.0.0.1:8000',
  },
]

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
  const [apiKey, setApiKey] = useState('')
  const [keysText, setKeysText] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [listed, setListed] = useState<string[]>([])

  const load = (data: JevInterceptConfig) => {
    setDraft(data)
    setApiKey('')
    setKeysText('')
    setClearKey(false)
  }

  const dirty =
    !!draft &&
    !!q.data &&
    (ownedOf(draft) !== ownedOf(q.data) ||
      apiKey.trim().length > 0 ||
      linesOf(keysText).length > 0 ||
      clearKey)
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error(translate('risk:noConfigToSave'))
      const body: Record<string, unknown> = {
        enabled: draft.enabled,
        provider: draft.provider || 'jev',
        base_url: draft.base_url,
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
      const keys = linesOf(keysText).slice(0, KEY_MAX)
      if (clearKey) body.api_keys = []
      else if (keys.length) body.api_keys = keys
      else if (apiKey.trim()) body.api_key = apiKey.trim()
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

  const fetchModels = useMutation({
    mutationFn: () => {
      if (!draft?.base_url.trim())
        throw new Error(translate('risk:modelUrlRequired'))
      return api<{ models: string[] }>('/api/panel/jev-intercept/models', {
        method: 'POST',
        body: JSON.stringify({
          base_url: draft.base_url.trim(),
          api_key: apiKey.trim(),
          timeout_ms: Number(draft.timeout_ms) || 2000,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = data.models || []
      setListed(ids)
      setDraft((prev) => {
        if (!prev || prev.model.trim()) return prev
        const preferred =
          prev.providers?.find((item) => item.id === (prev.provider || 'jev'))
            ?.default_model || ''
        const pick =
          (preferred && ids.includes(preferred) ? preferred : ids[0]) || ''
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

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft) return <div className='h-40 animate-pulse bg-muted/40' />

  const providers = PROVIDERS.map((item) => {
    const remote = (draft.providers || []).find((row) => row.id === item.id)
    return {
      ...item,
      label: remote?.label || item.label,
      default_model: remote?.default_model ?? item.default_model,
      default_base_url: remote?.default_base_url || item.default_base_url,
    }
  })
  const provider = draft.provider || 'jev'
  const current = providers.find((item) => item.id === provider) || providers[0]
  const applyProvider = (id: JevInterceptConfig['provider']) => {
    const next = providers.find((item) => item.id === id) || current
    const base = draft.base_url.trim().replace(/\/+$/, '')
    const model = draft.model.trim()
    const baseIsDefault =
      !base ||
      providers.some(
        (item) => (item.default_base_url || '').replace(/\/+$/, '') === base
      )
    const modelIsDefault = providers.some(
      (item) => (item.default_model || '') === model
    )
    setListed([])
    setDraft({
      ...draft,
      provider: id,
      base_url: baseIsDefault ? next.default_base_url || '' : draft.base_url,
      model: modelIsDefault ? next.default_model || '' : draft.model,
    })
  }
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

      <Group title={translate('risk:connection')}>
        <div className='space-y-4 rounded-xl border p-4'>
          <Segmented
            value={provider}
            options={providers.map((item) => ({
              value: item.id,
              label: item.label,
            }))}
            onChange={(id) => applyProvider(id)}
          />
          <div className='space-y-3'>
            <FieldLine label={translate('risk:url')} htmlFor='jev-base'>
              <div className='flex gap-2'>
                <Input
                  id='jev-base'
                  className='font-mono'
                  value={draft.base_url}
                  placeholder={current.default_base_url || 'https://'}
                  onChange={(e) =>
                    setDraft({ ...draft, base_url: e.target.value })
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0 cursor-pointer'
                  onClick={() =>
                    setDraft({
                      ...draft,
                      base_url: current.default_base_url || '',
                    })
                  }
                >
                  {translate('risk:default')}
                </Button>
              </div>
            </FieldLine>
            <FieldLine label={translate('risk:key')} htmlFor='jev-key'>
              <Input
                id='jev-key'
                type='password'
                autoComplete='off'
                value={apiKey}
                placeholder={
                  draft.api_key_count
                    ? translate('risk:savedKeysUnchanged', {
                        p0: draft.api_key_count,
                      })
                    : translate('risk:localServiceKeyHint')
                }
                onChange={(e) => {
                  setApiKey(e.target.value)
                  if (e.target.value) setClearKey(false)
                }}
              />
            </FieldLine>
            <FieldLine label={translate('risk:model')} htmlFor='jev-model'>
              <div className='flex gap-2'>
                <Input
                  id='jev-model'
                  className='font-mono'
                  value={draft.model}
                  placeholder={
                    current.default_model || translate('risk:modelEmptyHint')
                  }
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value })
                  }
                />
                <Button
                  type='button'
                  variant='outline'
                  className='shrink-0 cursor-pointer'
                  loading={fetchModels.isPending}
                  disabled={fetchModels.isPending || !draft.base_url.trim()}
                  onClick={() => fetchModels.mutate()}
                >
                  {translate('risk:fetchModels')}
                </Button>
              </div>
            </FieldLine>
            <FieldLine
              label={translate('risk:timeoutMilliseconds')}
              htmlFor='jev-timeout'
            >
              <Input
                id='jev-timeout'
                type='number'
                min={200}
                max={8000}
                className='max-w-40 tabular-nums'
                value={draft.timeout_ms}
                onChange={(e) =>
                  setDraft({ ...draft, timeout_ms: Number(e.target.value) })
                }
              />
            </FieldLine>
          </div>
          {listed.length ? (
            <div className='flex flex-wrap gap-1.5 border-t pt-3'>
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
          ) : (
            <p className='border-t pt-3 text-xs text-muted-foreground'>
              {translate('risk:fetchModelsHint')}
            </p>
          )}
        </div>
        <FoldStack>
          <Fold
            flush
            title={translate('risk:multipleKeys')}
            meta={
              draft.api_key_count
                ? translate('risk:savedKeyScheduling', {
                    p0: draft.api_key_count,
                  })
                : translate('risk:maxKeys', { count: KEY_MAX })
            }
          >
            <div className='space-y-3'>
              <Textarea
                aria-label={translate('risk:multipleKeys')}
                rows={3}
                className='font-mono text-xs'
                value={keysText}
                placeholder={translate('risk:multipleKeysHint')}
                onChange={(e) => {
                  setKeysText(e.target.value)
                  if (e.target.value.trim()) setClearKey(false)
                }}
              />
              <ToggleItem
                label={translate('risk:clearSavedKeys')}
                desc={translate('risk:keepSavedKeysHint')}
              >
                <Switch
                  checked={clearKey}
                  disabled={!draft.api_key_set && !clearKey}
                  onCheckedChange={(v) => {
                    setClearKey(v)
                    if (v) {
                      setApiKey('')
                      setKeysText('')
                    }
                  }}
                />
              </ToggleItem>
            </div>
          </Fold>
        </FoldStack>
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

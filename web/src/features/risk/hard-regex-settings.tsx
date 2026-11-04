import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type { JevInterceptConfig, PolicyRule } from '@/types/panel-routing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/features/settings/save-bar'
import { Group, ToggleItem, ToggleList } from './blocks'
import { jevInterceptQueryOptions } from './queries'

const RULE_LABELS: Record<string, string> = {
  get nsfw() {
    return translate('risk:nsfw')
  },
  get distill() {
    return translate('risk:distillation')
  },
  get crack() {
    return translate('risk:cracking')
  },
  get jailbreak() {
    return translate('risk:jailbreak')
  },
  get custom() {
    return translate('risk:custom')
  },
}

function linesOf(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function ruleKey(rules: PolicyRule[] = []) {
  return JSON.stringify(
    rules
      .filter((rule) => rule.source.trim())
      .map((rule) => ({
        category: rule.category || 'custom',
        source: rule.source.trim(),
        enabled: rule.enabled !== false,
      }))
  )
}

type Draft = {
  hard_regex_enabled: boolean
  openai_platform_enabled: boolean
  expand_base64: boolean
  strip_reminders: boolean
  rules: PolicyRule[]
  patterns: string
}

function draftOf(data: JevInterceptConfig): Draft {
  return {
    hard_regex_enabled: data.hard_regex_enabled,
    openai_platform_enabled: data.openai_platform_enabled === true,
    expand_base64: data.expand_base64 !== false,
    strip_reminders: data.strip_reminders !== false,
    rules: data.rules || [],
    patterns: (data.patterns || []).join('\n'),
  }
}

function draftDiffers(draft: Draft, saved: Draft) {
  return (
    draft.hard_regex_enabled !== saved.hard_regex_enabled ||
    draft.openai_platform_enabled !== saved.openai_platform_enabled ||
    draft.expand_base64 !== saved.expand_base64 ||
    draft.strip_reminders !== saved.strip_reminders ||
    ruleKey(draft.rules) !== ruleKey(saved.rules) ||
    linesOf(draft.patterns).join('\n') !== linesOf(saved.patterns).join('\n')
  )
}

/** The stored hit carries `rule.source.slice(0, 120)`; find the rule it came from. */
function ruleIndexOf(rules: PolicyRule[], source: string) {
  const want = source.trim()
  if (!want) return -1
  return rules.findIndex((rule) => rule.source.trim().slice(0, 120) === want)
}

export function HardRegexSettings({
  focusRule,
  onDirtyChange,
}: {
  /** Rule source picked from today's hits; scrolled to and highlighted. */
  focusRule: string | null
  onDirtyChange: (dirty: boolean) => void
}) {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  const [draft, setDraft] = useServerDraft(q.data, draftOf, draftDiffers)
  const listRef = useRef<HTMLUListElement>(null)

  const focusIndex =
    draft && focusRule ? ruleIndexOf(draft.rules, focusRule) : -1
  useEffect(() => {
    if (focusIndex < 0) return
    listRef.current
      ?.querySelector(`[data-rule='${focusIndex}']`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusIndex, focusRule])

  const saved = q.data ? draftOf(q.data) : null
  const dirty = !!draft && !!saved && draftDiffers(draft, saved)
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error(translate('risk:noConfigToSave'))
      const body: Record<string, unknown> = {
        hard_regex_enabled: draft.hard_regex_enabled,
        openai_platform_enabled: draft.openai_platform_enabled,
        expand_base64: draft.expand_base64,
        strip_reminders: draft.strip_reminders,
        patterns: linesOf(draft.patterns),
      }
      const builtin = q.data?.builtin_rules || []
      const current = draft.rules.filter((rule) => rule.source.trim())
      if (q.data?.rules_customized || ruleKey(current) !== ruleKey(builtin)) {
        // null resets to the shipped list so later builtin updates still apply.
        body.rules = ruleKey(current) === ruleKey(builtin) ? null : current
      }
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },
    onSuccess: (data) => {
      toast.success(translate('risk:hardRegexSaved'))
      setDraft(draftOf(data))
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
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

  const setRule = (index: number, next: Partial<PolicyRule>) =>
    setDraft({
      ...draft,
      rules: draft.rules.map((rule, i) =>
        i === index ? { ...rule, ...next } : rule
      ),
    })
  const enabledCount = draft.rules.filter((r) => r.enabled !== false).length

  return (
    <div className='space-y-8 p-4'>
      <Group title={translate('risk:whenToBlock')}>
        <ToggleList>
          <ToggleItem
            label={translate('risk:hardRegex')}
            desc={translate('risk:regexBlockHint')}
          >
            <Switch
              checked={draft.hard_regex_enabled}
              onCheckedChange={(v) =>
                setDraft({ ...draft, hard_regex_enabled: v })
              }
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:openaiPlatform')}
            desc={translate('risk:openaiScopeHint')}
          >
            <Switch
              checked={draft.openai_platform_enabled}
              onCheckedChange={(v) =>
                setDraft({ ...draft, openai_platform_enabled: v })
              }
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:expandBase64')}
            desc={translate('risk:expandBase64Hint')}
          >
            <Switch
              checked={draft.expand_base64}
              onCheckedChange={(v) => setDraft({ ...draft, expand_base64: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:stripReminders')}
            desc={translate('risk:stripRemindersHint')}
          >
            <Switch
              checked={draft.strip_reminders}
              onCheckedChange={(v) =>
                setDraft({ ...draft, strip_reminders: v })
              }
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:distillCategory')}
            desc={translate('risk:distillCategoryHint')}
          >
            <span className='text-xs text-muted-foreground'>
              {translate('risk:controlledByDistillation')}
            </span>
          </ToggleItem>
        </ToggleList>
      </Group>

      <Group
        title={translate('risk:rules')}
        hint={translate('risk:enabledRulesHint', {
          p0: enabledCount,
          p1: draft.rules.length,
        })}
        action={
          <div className='flex gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='cursor-pointer'
              onClick={() =>
                setDraft({
                  ...draft,
                  rules: [
                    ...draft.rules,
                    { category: 'custom', source: '', enabled: true },
                  ],
                })
              }
            >
              {translate('risk:addRule')}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='cursor-pointer'
              onClick={() =>
                setDraft({ ...draft, rules: q.data?.builtin_rules || [] })
              }
            >
              {translate('risk:restoreBuiltIn')}
            </Button>
          </div>
        }
      >
        <ul
          ref={listRef}
          className='max-h-[28rem] divide-y overflow-y-auto rounded-xl border'
        >
          {draft.rules.map((rule, index) => (
            <li
              key={index}
              data-rule={index}
              className={cn(
                'flex items-center gap-2 px-3 py-2 transition-colors duration-500',
                index === focusIndex && 'bg-[var(--status-caution-bg)]',
                rule.enabled === false && 'text-muted-foreground'
              )}
            >
              <Switch
                checked={rule.enabled !== false}
                onCheckedChange={(enabled) => setRule(index, { enabled })}
                aria-label={translate('risk:enableRule')}
              />
              <select
                aria-label={translate('risk:category')}
                className='h-8 shrink-0 rounded-md border bg-background px-2 text-xs'
                value={rule.category || 'custom'}
                onChange={(e) => setRule(index, { category: e.target.value })}
              >
                {Object.entries(RULE_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <Input
                aria-label={translate('risk:regex')}
                className='h-8 font-mono text-xs'
                value={rule.source}
                onChange={(e) => setRule(index, { source: e.target.value })}
              />
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='shrink-0 cursor-pointer'
                onClick={() =>
                  setDraft({
                    ...draft,
                    rules: draft.rules.filter((_, i) => i !== index),
                  })
                }
              >
                {translate('risk:delete')}
              </Button>
            </li>
          ))}
          {draft.rules.length ? null : (
            <li className='px-3 py-6 text-sm text-muted-foreground'>
              {translate('risk:noRules')}
            </li>
          )}
        </ul>
      </Group>

      <Group
        title={translate('risk:extraRegex')}
        hint={translate('risk:extraRegexCategoryHint')}
      >
        <Textarea
          aria-label={translate('risk:extraRegex')}
          rows={5}
          className='font-mono text-xs'
          value={draft.patterns}
          onChange={(e) => setDraft({ ...draft, patterns: e.target.value })}
          placeholder={translate('risk:onePerLine')}
        />
      </Group>

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => q.data && setDraft(draftOf(q.data))}
        />
      ) : null}
    </div>
  )
}

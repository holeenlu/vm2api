import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JevInterceptConfig, JevScopeOption } from '@/types/panel-routing'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/features/settings/save-bar'
import { Group } from './blocks'
import { type AccountScope, scopeConfigured, scopeMatches } from './model'
import { jevInterceptQueryOptions } from './queries'

type Draft = {
  account_platform_plans: string[]
  account_ids: string
}

function draftOf(data: JevInterceptConfig): Draft {
  return {
    account_platform_plans: data.account_platform_plans || [],
    account_ids: (data.account_ids || []).join('\n'),
  }
}

function linesOf(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function scopeOf(draft: Draft): AccountScope {
  return {
    account_platform_plans: draft.account_platform_plans,
    account_ids: linesOf(draft.account_ids),
  }
}

function sameScope(left: AccountScope, right: AccountScope) {
  return (
    [...left.account_platform_plans].sort().join('\n') ===
      [...right.account_platform_plans].sort().join('\n') &&
    [...left.account_ids].sort().join('\n') ===
      [...right.account_ids].sort().join('\n')
  )
}

function scopeDiffers(left: Draft, right: Draft) {
  return !sameScope(scopeOf(left), scopeOf(right))
}

function Chip({
  option,
  active,
  onToggle,
}: {
  option: JevScopeOption
  active: boolean
  onToggle: () => void
}) {
  useTranslation('risk')

  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'flex cursor-pointer items-baseline gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors duration-150',
        active
          ? 'border-select-border bg-select-surface text-foreground'
          : 'border-border bg-card text-muted-foreground hover:border-select-border/60 hover:text-foreground'
      )}
    >
      <span>{option.label}</span>
      <span className='tabular-nums opacity-60'>{option.count}</span>
    </button>
  )
}

/**
 * 风控的账号范围，独立于当前关卡。按平台+套餐收窄，可收起。
 * 全空 = 所有账号都进关卡。指定账号和勾选是并集。
 */
export function AccountScopeSettings() {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  const [draft, setDraft] = useServerDraft(q.data, draftOf, scopeDiffers)
  const [open, setOpen] = useState(false)

  const saved = q.data ? draftOf(q.data) : null
  const current = draft ? scopeOf(draft) : null
  const dirty = !!current && !!saved && !sameScope(current, scopeOf(saved))

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error(translate('risk:noConfigToSave'))
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify({
          account_platform_plans: draft.account_platform_plans,
          account_ids: linesOf(draft.account_ids),
          account_types: [],
          account_plan_types: [],
        }),
      })
    },
    onSuccess: (data) => {
      toast.success(translate('risk:scopeSaved'))
      setDraft(draftOf(data))
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p
        className='rounded-xl border px-4 py-3 text-sm text-destructive'
        role='alert'
      >
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft || !current) {
    return <div className='h-12 animate-pulse rounded-xl bg-muted/40' />
  }

  const inventory = q.data?.account_scope
  const accounts = inventory?.accounts || []
  const total = inventory?.accounts_total ?? accounts.length
  const options = inventory?.account_platform_plan_options || []
  const configured = scopeConfigured(current)
  const matched = configured ? scopeMatches(current, accounts) : accounts
  const selectedLabels = options
    .filter((option) => draft.account_platform_plans.includes(option.id))
    .map((option) => option.label)
  const named = linesOf(draft.account_ids).length
  const summary = configured
    ? [
        selectedLabels.join('、') ||
          (named
            ? translate('risk:specificAccounts')
            : translate('risk:noneSelected')),
        named ? translate('risk:additionalAccounts', { p0: named }) : '',
        translate('risk:scopeMatches', { p0: matched.length, p1: total }),
      ]
        .filter(Boolean)
        .join(' · ')
    : translate('risk:allAccountCount', { p0: total })
  const shown = open || dirty

  const toggle = (id: string) =>
    setDraft({
      ...draft,
      account_platform_plans: draft.account_platform_plans.includes(id)
        ? draft.account_platform_plans.filter((item) => item !== id)
        : [...draft.account_platform_plans, id],
    })

  return (
    <Collapsible
      open={shown}
      onOpenChange={(next) => {
        if (!next && dirty) return
        setOpen(next)
      }}
      className='rounded-xl border bg-card'
    >
      <CollapsibleTrigger className='flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
        <span className='shrink-0 text-sm font-semibold'>
          {translate('risk:accountScope')}
        </span>
        <span className='flex min-w-0 items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{summary}</span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 transition-transform duration-200',
              shown && 'rotate-180'
            )}
            aria-hidden='true'
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-6 border-t px-4 py-4'>
        <p className='text-xs leading-5 text-muted-foreground'>
          {translate('risk:scopeDescription')}
        </p>

        <Group
          title={translate('risk:platformAndPlan')}
          hint={translate('risk:planGroupingHint')}
          action={
            draft.account_platform_plans.length ? (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='cursor-pointer text-xs'
                onClick={() =>
                  setDraft({ ...draft, account_platform_plans: [] })
                }
              >
                {translate('risk:clear')}
              </Button>
            ) : undefined
          }
        >
          {options.length ? (
            <div className='flex flex-wrap gap-2'>
              {options.map((option) => (
                <Chip
                  key={option.id}
                  option={option}
                  active={draft.account_platform_plans.includes(option.id)}
                  onToggle={() => toggle(option.id)}
                />
              ))}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>
              {translate('risk:noSlots')}
            </p>
          )}
        </Group>

        <Group
          title={translate('risk:specificAccounts')}
          hint={translate('risk:accountInputHint')}
        >
          <Textarea
            aria-label={translate('risk:specificAccounts')}
            rows={3}
            className='font-mono text-xs'
            placeholder={'vm-02\naldanacharles9564@aol.com'}
            value={draft.account_ids}
            onChange={(event) =>
              setDraft({ ...draft, account_ids: event.target.value })
            }
          />
        </Group>

        <div className='space-y-1 text-xs leading-5'>
          <p className='font-medium'>
            {configured
              ? translate('risk:scopeSlotMatches', {
                  p0: matched.length,
                  p1: total,
                })
              : translate('risk:allSlotsInScope', { count: total })}
          </p>
          {configured && !matched.length ? (
            <p className='text-[var(--status-caution)]'>
              {translate('risk:noScopeMatches')}
            </p>
          ) : null}
        </div>

        {dirty ? (
          <SaveBar
            saving={save.isPending}
            onSave={() => save.mutate()}
            onDiscard={() => q.data && setDraft(draftOf(q.data))}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

import { t as translate } from '@/i18n'
import type { JevScopeAccount } from '@/types/panel-routing'
import type { UsageLogRow } from '@/types/panel-usage-logs'

/** Gate order matches `evaluateProtocolIntercept`: cheap rules first, the model last. */
export type StageId = 'distill' | 'hard-regex' | 'refusal' | 'jev'
export type ViewKey = 'all' | StageId | 'pass'

export const STAGES: { id: StageId; name: string; does: string }[] = [
  {
    id: 'distill',
    get name() {
      return translate('risk:distillation')
    },
    get does() {
      return translate('risk:distillStageDescription')
    },
  },
  {
    id: 'hard-regex',
    get name() {
      return translate('risk:hardRegex')
    },
    get does() {
      return translate('risk:regexStageDescription')
    },
  },
  {
    id: 'refusal',
    get name() {
      return translate('risk:refusalCache')
    },
    get does() {
      return translate('risk:refusalStageDescription')
    },
  },
  {
    id: 'jev',
    get name() {
      return translate('risk:decisionModel')
    },
    get does() {
      return translate('risk:modelStageDescription')
    },
  },
]

export const VIEW_KEYS: ViewKey[] = ['all', ...STAGES.map((s) => s.id), 'pass']

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && VIEW_KEYS.includes(value as ViewKey)
}

export const PASS_REASONS: Record<string, { label: string; hint: string }> = {
  jev: {
    get label() {
      return translate('risk:modelSafe')
    },
    get hint() {
      return translate('risk:modelScored')
    },
  },
  regex: {
    get label() {
      return translate('risk:regexNoMatch')
    },
    get hint() {
      return translate('risk:modelDisabledOrSkipped')
    },
  },
  'fail-open': {
    get label() {
      return translate('risk:modelFailOpen')
    },
    get hint() {
      return translate('risk:scoringFailedAllowed')
    },
  },
  unchecked: {
    get label() {
      return translate('risk:unchecked')
    },
    get hint() {
      return translate('risk:noRulesRunning')
    },
  },
  platform: {
    get label() {
      return translate('risk:openaiNotEnabled')
    },
    get hint() {
      return translate('risk:openaiNotEnabledHint')
    },
  },
  scope: {
    get label() {
      return translate('risk:accountOutOfScope')
    },
    get hint() {
      return translate('risk:accountOutOfScopeHint')
    },
  },
  'scope-wait': {
    get label() {
      return translate('risk:awaitingAccount')
    },
    get hint() {
      return translate('risk:awaitingAccountHint')
    },
  },
  unknown: {
    get label() {
      return translate('risk:bypassedGates')
    },
    get hint() {
      return translate('risk:bypassedGatesHint')
    },
  },
}

/** 风控的账号范围。一对是 `claude:max` / `gpt:plus` 这种平台+套餐。 */
export type AccountScope = {
  account_platform_plans: string[]
  account_ids: string[]
}

export function scopeConfigured(scope: AccountScope) {
  return scope.account_platform_plans.length > 0 || scope.account_ids.length > 0
}

/**
 * 与后端 `jevAccountInScope` 同一套判断：平台+套餐和指定账号取并集，
 * 全空 = 所有账号。面板用它实时算「当前范围命中几个槽位」。
 */
export function accountInScope(scope: AccountScope, account: JevScopeAccount) {
  if (!scopeConfigured(scope)) return true
  const ids = scope.account_ids.map((item) => item.trim().toLowerCase())
  const id = (account.id || '').trim().toLowerCase()
  const email = (account.email || '').trim().toLowerCase()
  const name = (account.name || '').trim().toLowerCase()
  if (
    ids.some((want) => want && (want === id || want === email || want === name))
  )
    return true
  const key = (account.scope_key || '').trim().toLowerCase()
  return !!key && scope.account_platform_plans.includes(key)
}

export function scopeMatches(scope: AccountScope, accounts: JevScopeAccount[]) {
  return accounts.filter((account) => accountInScope(scope, account))
}

/** `upstream` = passed every gate and the upstream refused it. */
export type FeedKind = StageId | 'upstream'

export function feedKindOf(row: UsageLogRow): FeedKind {
  const state = row.finalState || ''
  const via = row.via || ''
  if (state === 'distill_blocked' || via === 'distill-detect') return 'distill'
  if (via === 'hard-regex') return 'hard-regex'
  if (via === 'jev') return 'jev'
  if (state.startsWith('refusal_') || via === 'refusal-guard') return 'refusal'
  return 'upstream'
}

const REFUSAL_MATCH: Record<string, string> = {
  get refusal_guard() {
    return translate('risk:exactFingerprint')
  },
  get refusal_similar() {
    return translate('risk:similarBody')
  },
  get refusal_device() {
    return translate('risk:blockedDevice')
  },
}

/** The part of the stored block message that says why: `nsfw: 关键词`. */
export function evidenceOf(row: UsageLogRow): string {
  const kind = feedKindOf(row)
  if (kind === 'refusal')
    return REFUSAL_MATCH[row.finalState || ''] || translate('risk:refusal')
  const text = String(row.errorMessage || row.blockedReason || '').trim()
  if (kind === 'upstream') return text
  const at = text.search(/[:：]/)
  return at >= 0 ? text.slice(at + 1).trim() : text
}

export function share(part: number, whole: number) {
  if (!whole || !part) return '0%'
  const value = (part / whole) * 100
  if (value < 0.1) return '<0.1%'
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

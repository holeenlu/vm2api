import crypto from 'node:crypto'

/**
 * Structured account failure protection.
 *
 * This module only compiles and evaluates policy facts. It does not change
 * scheduling, cooldowns, credentials, or protocol responses. The caller owns
 * persistence and decides whether a matched policy is safe to apply.
 */

export const ACCOUNT_ERROR_FIELDS = Object.freeze(['provider', 'status', 'code', 'type', 'message'])
export const ACCOUNT_ERROR_OPERATORS = Object.freeze(['equals', 'contains'])

export const DEFAULT_ACCOUNT_ERROR_PROTECTION = Object.freeze({
  enabled: false,
  threshold: 12,
  windowMs: 10 * 60_000,
  durationMs: 2 * 60 * 60_000,
  probeEnabled: true,
  probeModel: null,
  rules: Object.freeze([]),
})

const LIMITS = Object.freeze({
  maxRules: 32,
  maxConditions: 8,
  maxValues: 16,
  maxRuleText: 128,
  maxMessageValue: 1024,
  maxOtherValue: 256,
  maxTotalText: 65_536,
})

function text(value) {
  return String(value ?? '').trim()
}

function boundedText(value, max = LIMITS.maxRuleText) {
  return text(value).slice(0, max)
}

function bool(value, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function integer(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) ? number : fallback
}

function normalizeField(value) {
  const field = String(value || '')
    .trim()
    .toLowerCase()
  return ACCOUNT_ERROR_FIELDS.includes(field) ? field : ''
}

function normalizeOperator(value) {
  const operator = String(value || '')
    .trim()
    .toLowerCase()
  return ACCOUNT_ERROR_OPERATORS.includes(operator) ? operator : ''
}

function normalizeValues(values) {
  if (!Array.isArray(values)) return []
  return values.map((value) => (value == null ? null : String(value).trim()))
}

function normalizeCondition(condition = {}) {
  const field = normalizeField(condition.field)
  const operator = normalizeOperator(condition.operator)
  const values = normalizeValues(condition.values)
  return {
    field,
    operator,
    values,
    ignoreCase: bool(condition.ignoreCase ?? condition.ignore_case, false),
  }
}

function normalizeRule(rule = {}) {
  return {
    id: text(rule.id),
    name: text(rule.name),
    conditions: Array.isArray(rule.conditions) ? rule.conditions.map(normalizeCondition) : [],
  }
}

export function normalizeAccountErrorProtection(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rules = Array.isArray(source.rules) ? source.rules.map(normalizeRule) : []
  return {
    enabled: bool(source.enabled, DEFAULT_ACCOUNT_ERROR_PROTECTION.enabled),
    threshold: integer(source.threshold, DEFAULT_ACCOUNT_ERROR_PROTECTION.threshold),
    windowMs: integer(
      source.windowMs ?? source.window_ms ?? Number(source.windowSeconds) * 1000,
      DEFAULT_ACCOUNT_ERROR_PROTECTION.windowMs,
    ),
    durationMs: integer(
      source.durationMs ?? source.duration_ms ?? Number(source.durationSeconds) * 1000,
      DEFAULT_ACCOUNT_ERROR_PROTECTION.durationMs,
    ),
    probeEnabled: bool(source.probeEnabled ?? source.probe_enabled, DEFAULT_ACCOUNT_ERROR_PROTECTION.probeEnabled),
    probeModel: source.probeModel == null ? null : text(source.probeModel) || null,
    rules,
  }
}

export function validateAccountErrorProtection(raw = {}) {
  const policy = normalizeAccountErrorProtection(raw)
  if (!Number.isInteger(policy.threshold) || policy.threshold < 2 || policy.threshold > 1000) {
    return { ok: false, code: 'invalid_threshold', policy }
  }
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 60_000 || policy.windowMs > 3_600_000) {
    return { ok: false, code: 'invalid_window_ms', policy }
  }
  if (!Number.isInteger(policy.durationMs) || policy.durationMs < 300_000 || policy.durationMs > 604_800_000) {
    return { ok: false, code: 'invalid_duration_ms', policy }
  }
  if (policy.probeModel != null && !validLabel(policy.probeModel, 128)) {
    return { ok: false, code: 'invalid_probe_model', policy }
  }
  if (policy.rules.length > LIMITS.maxRules) return { ok: false, code: 'too_many_rules', policy }
  if (policy.enabled && policy.rules.length === 0) return { ok: false, code: 'rules_required', policy }

  const ids = new Set()
  let totalText = policy.probeModel?.length || 0
  for (const rule of policy.rules) {
    totalText += rule.id.length + rule.name.length
    if (!validLabel(rule.id, LIMITS.maxRuleText) || !validLabel(rule.name, LIMITS.maxRuleText) || ids.has(rule.id)) {
      return { ok: false, code: 'invalid_rule_id', policy }
    }
    ids.add(rule.id)
    if (rule.conditions.length === 0 || rule.conditions.length > LIMITS.maxConditions) {
      return { ok: false, code: 'invalid_rule_conditions', policy }
    }
    if (!rule.conditions.some((condition) => condition.field && condition.field !== 'provider')) {
      return { ok: false, code: 'provider_only_rule', policy }
    }
    for (const condition of rule.conditions) {
      const max = condition.field === 'message' ? LIMITS.maxMessageValue : LIMITS.maxOtherValue
      if (!ACCOUNT_ERROR_FIELDS.includes(condition.field) || !ACCOUNT_ERROR_OPERATORS.includes(condition.operator)) {
        return { ok: false, code: 'invalid_condition', policy }
      }
      if (condition.values.length === 0 || condition.values.length > LIMITS.maxValues) {
        return { ok: false, code: 'invalid_condition_values', policy }
      }
      if (condition.operator === 'contains' && condition.field !== 'message') {
        return { ok: false, code: 'contains_only_message', policy }
      }
      for (const value of condition.values) {
        if (value != null && value.length > max) return { ok: false, code: 'condition_value_too_long', policy }
        if (condition.operator === 'contains' && !String(value || '').trim()) {
          return { ok: false, code: 'empty_contains_value', policy }
        }
        if (
          condition.field === 'status' &&
          value != null &&
          (!/^\d{3}$/.test(value) || Number(value) < 100 || Number(value) > 599)
        ) {
          return { ok: false, code: 'invalid_status', policy }
        }
        totalText += value?.length || 0
      }
    }
  }
  if (totalText > LIMITS.maxTotalText) return { ok: false, code: 'policy_too_large', policy }
  return { ok: true, policy }
}

function canonicalPolicy(policy) {
  return {
    enabled: policy.enabled,
    threshold: policy.threshold,
    windowMs: policy.windowMs,
    durationMs: policy.durationMs,
    probeEnabled: policy.probeEnabled,
    probeModel: policy.probeModel,
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      conditions: rule.conditions.map((condition) => ({
        field: condition.field,
        operator: condition.operator,
        values: condition.values,
        ignoreCase: condition.ignoreCase,
      })),
    })),
  }
}

function fingerprint(policy) {
  const hash = crypto.createHash('sha256')
  const value = (input) => {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input))
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64LE(BigInt(bytes.length))
    hash.update(length)
    hash.update(bytes)
  }
  value(Buffer.from([policy.enabled ? 1 : 0, policy.probeEnabled ? 1 : 0]))
  const integer = (number) => {
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeBigUInt64LE(BigInt(number))
    value(bytes)
  }
  integer(policy.threshold)
  integer(policy.windowMs)
  integer(policy.durationMs)
  value(policy.probeModel || '')
  for (const rule of policy.rules) {
    value(rule.id)
    value(rule.name)
    integer(rule.conditions.length)
    for (const condition of rule.conditions) {
      value(
        Buffer.from([
          ACCOUNT_ERROR_FIELDS.indexOf(condition.field),
          ACCOUNT_ERROR_OPERATORS.indexOf(condition.operator),
          condition.ignoreCase ? 1 : 0,
        ]),
      )
      integer(condition.values.length)
      for (const candidate of condition.values) {
        value(Buffer.from([candidate == null ? 0 : 1]))
        value(candidate || '')
      }
    }
  }
  return hash.digest('hex')
}

function validLabel(value, max) {
  return (
    value.length > 0 &&
    value === value.trim() &&
    value.length <= max &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  )
}

function normalizedValue(value, ignoreCase) {
  if (value == null) return null
  const result = String(value).trim()
  return ignoreCase ? result.toLowerCase() : result
}

function fieldValue(facts, field) {
  if (!facts || typeof facts !== 'object') return null
  const value = facts[field]
  if (value == null) return null
  const result = String(value)
  return field === 'message' ? result.slice(0, 8192) : result.slice(0, 1024)
}

function conditionMatches(condition, facts) {
  const actual = normalizedValue(fieldValue(facts, condition.field), condition.ignoreCase)
  return condition.values.some((candidate) => {
    const expected = normalizedValue(candidate, condition.ignoreCase)
    if (expected == null) return actual == null
    if (actual == null) return false
    return condition.operator === 'contains' ? actual.includes(expected) : actual === expected
  })
}

export function compileAccountErrorProtection(raw = {}) {
  const validation = validateAccountErrorProtection(raw)
  if (!validation.ok) {
    const error = new Error(`invalid account error protection: ${validation.code}`)
    error.code = validation.code
    error.policy = validation.policy
    throw error
  }
  const policy = validation.policy
  const compiledRules = policy.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    conditions: rule.conditions,
  }))
  return Object.freeze({
    policy: Object.freeze(canonicalPolicy(policy)),
    fingerprint: fingerprint(policy),
    matchingRules(facts = {}) {
      if (!policy.enabled) return []
      return compiledRules
        .filter((rule) => rule.conditions.every((condition) => conditionMatches(condition, facts)))
        .map(({ id, name }) => ({ id, name }))
    },
  })
}

export function errorFactsFromResult(result = {}, { provider = null } = {}) {
  const body = result?.body
  const error = body && typeof body === 'object' ? body.error : null
  const message =
    typeof body === 'string' ? body : String(error?.message || error?.error || body?.message || body?.error || '')
  return {
    provider: provider == null ? null : String(provider),
    status: Number.isFinite(Number(result?.status)) && Number(result.status) > 0 ? String(Number(result.status)) : null,
    code: error?.code ?? error?.type ?? body?.code ?? body?.type ?? null,
    type: error?.type ?? body?.type ?? null,
    message,
  }
}

export function normalizeProtectionState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    policyFingerprint: boundedText(source.policyFingerprint ?? source.policy_fingerprint ?? '', 128) || null,
    credentialGeneration: Number(source.credentialGeneration ?? source.credential_generation) || 0,
    windowStartedAt: Number(source.windowStartedAt ?? source.window_started_at) || 0,
    count: Math.max(0, Number(source.count) || 0),
    frozenUntil: Math.max(0, Number(source.frozenUntil ?? source.frozen_until) || 0),
    matchedRules: Array.isArray(source.matchedRules ?? source.matched_rules)
      ? (source.matchedRules ?? source.matched_rules)
          .filter((rule) => rule && typeof rule === 'object' && rule.id)
          .map((rule) => ({ id: boundedText(rule.id), name: boundedText(rule.name) }))
      : [],
    generation: Math.max(0, Number(source.generation) || 0),
    probePending: Boolean(source.probePending ?? source.probe_pending),
    lastProbeAt: Math.max(0, Number(source.lastProbeAt ?? source.last_probe_at) || 0),
  }
}

export function recordProtectionFailure(
  compiled,
  rawState,
  facts,
  { now = Date.now(), credentialGeneration = 0 } = {},
) {
  const state = normalizeProtectionState(rawState)
  const next = { ...state }
  const generation = Number(credentialGeneration) || 0
  const policyChanged = state.policyFingerprint !== compiled.fingerprint
  const credentialChanged = state.credentialGeneration !== generation
  if (policyChanged || credentialChanged) {
    next.policyFingerprint = compiled.fingerprint
    next.credentialGeneration = generation
    next.windowStartedAt = now
    next.count = 0
    // A policy or credential revision starts a new protection epoch.  Do not
    // let a freeze created under the old epoch suppress the first evaluation
    // of the new one.
    next.frozenUntil = 0
    next.matchedRules = []
    next.probePending = false
  }
  if (next.frozenUntil > now) return { matched: false, frozen: true, state: next, rules: next.matchedRules }
  if (next.frozenUntil) next.frozenUntil = 0
  if (!next.windowStartedAt || now - next.windowStartedAt > compiled.policy.windowMs) {
    next.windowStartedAt = now
    next.count = 0
    next.matchedRules = []
  }
  const rules = compiled.matchingRules(facts)
  if (!rules.length) return { matched: false, frozen: false, state: next, rules: [] }
  next.count += 1
  next.matchedRules = rules
  if (next.count < compiled.policy.threshold) return { matched: true, frozen: false, state: next, rules }
  next.frozenUntil = now + compiled.policy.durationMs
  // Start a fresh evidence window after the freeze.  This mirrors CPR's
  // atomic failure script and prevents the first post-freeze failure from
  // inheriting the old threshold.
  next.count = 0
  next.generation += 1
  next.probePending = compiled.policy.probeEnabled
  return { matched: true, frozen: true, state: next, rules }
}

export function recordProtectionSuccess(rawState, { now = Date.now() } = {}) {
  const state = normalizeProtectionState(rawState)
  if (state.frozenUntil > now) return state
  return {
    ...state,
    count: 0,
    frozenUntil: 0,
    windowStartedAt: now,
    matchedRules: [],
    probePending: false,
  }
}

export function clearProtectionState(rawState, { expectedGeneration = null } = {}) {
  const state = normalizeProtectionState(rawState)
  if (expectedGeneration != null && state.generation !== Number(expectedGeneration)) return null
  return {
    ...state,
    count: 0,
    frozenUntil: 0,
    matchedRules: [],
    probePending: false,
    generation: state.generation + 1,
  }
}

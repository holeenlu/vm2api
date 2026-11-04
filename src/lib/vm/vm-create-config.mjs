import { standardSeedPolicy } from '../protocol/seed-policy.mjs'
import { applyGeneratedFingerprint } from '../identity/workstation-fingerprint.mjs'
import { OS_CATALOG, STANDARD_LOCALE } from './vm-runtime.mjs'
import { stampVmKind, isCodexVm } from './vm-kind.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'

/** One creation configuration for operator and supplier entry points. Callers enforce their own scope. */
export function buildNewVmRecord({
  id,
  name,
  kernel,
  runtime,
  machine,
  generated,
  body = {},
  routing = {},
  status = 'stopped',
  ownerUserId = null,
  nodeId = null,
  proxy = null,
  vendorAccountResourceId = null,
}) {
  const timestamp = new Date().toISOString()
  const timezone = body.timezone || null
  const vm = {
    id,
    name,
    status,
    kernel,
    timezone,
    timezone_source: timezone ? 'manual' : 'auto',
    locale: generated.locale || STANDARD_LOCALE,
    region: body.region || body.zone || null,
    note: body.note || `${(OS_CATALOG[kernel] || {}).pretty || kernel} · Go slot worker`,
    proxy,
    policy: {
      maxConcurrency: 0,
      concurrencyOverride: false,
      maxRpm: 0,
      rpmOverride: false,
      maxSessions: 0,
      sessionsOverride: false,
      weight: Math.max(1, Math.min(100, Number(body.weight ?? 1))),
      inflight: 0,
    },
    claude: {},
    fingerprint: applyGeneratedFingerprint({}, generated),
    stats: {},
    created_at: timestamp,
    updated_at: timestamp,
    schedulable: false,
    schedule_disabled_reason: 'no_credential',
    unschedulable: { reason: 'no_credential', detail: null, at: timestamp },
    proxy_cli_enabled: body.proxy_cli_enabled === true,
    proxy_required: !!proxy,
    seed_policy: standardSeedPolicy(),
    runtime: { type: runtime },
    machine,
    owner_user_id: ownerUserId,
    origin: 'platform',
    ...(nodeId ? { node_id: nodeId } : {}),
    ...(vendorAccountResourceId ? { vendor_account_resource_id: vendorAccountResourceId } : {}),
  }
  stampVmKind(vm, body)
  const openaiPolicy = normalizeOpenAIQuotaPolicy(routing?.codex?.quota)
  const explicitConcurrency =
    Object.prototype.hasOwnProperty.call(body, 'max_concurrency') ||
    Object.prototype.hasOwnProperty.call(body, 'maxConcurrency')
  const explicitRpm =
    Object.prototype.hasOwnProperty.call(body, 'max_rpm') || Object.prototype.hasOwnProperty.call(body, 'maxRpm')
  const explicitSessions = Object.prototype.hasOwnProperty.call(body, 'max_sessions')
  const readField = (snake, camel) => (Object.prototype.hasOwnProperty.call(body, snake) ? body[snake] : body[camel])
  const rawConcurrency = readField('max_concurrency', 'maxConcurrency')
  const rawRpm = readField('max_rpm', 'maxRpm')
  const rawSessions = body.max_sessions
  const validInteger = (value, min, max) =>
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max
  const invalidCreate = (value, min, max) => value !== null && !validInteger(value, min, max)
  if (isCodexVm(vm)) {
    if (
      (explicitConcurrency && invalidCreate(rawConcurrency, 1, 256)) ||
      (explicitRpm && invalidCreate(rawRpm, 0, 1e6)) ||
      (explicitSessions && invalidCreate(rawSessions, 0, 256))
    ) {
      throw Object.assign(new Error('OpenAI scheduling values must be finite integers in range'), {
        code: 'invalid_create_schedule',
      })
    }
    vm.policy.maxConcurrency =
      explicitConcurrency && rawConcurrency !== null ? rawConcurrency : openaiPolicy.max_concurrency
    vm.policy.concurrencyOverride = explicitConcurrency && rawConcurrency !== null
    vm.policy.maxRpm = explicitRpm && rawRpm !== null ? rawRpm : openaiPolicy.max_rpm
    vm.policy.rpmOverride = explicitRpm && rawRpm !== null
    vm.policy.maxSessions = explicitSessions && rawSessions !== null ? rawSessions : openaiPolicy.max_sessions
    vm.policy.sessionsOverride = explicitSessions && rawSessions !== null
  } else {
    if (
      (explicitConcurrency && invalidCreate(rawConcurrency, 0, 256)) ||
      (explicitRpm && invalidCreate(rawRpm, 0, 1e6)) ||
      explicitSessions
    ) {
      throw Object.assign(new Error('Claude scheduling values are invalid or unsupported'), {
        code: 'invalid_create_schedule',
      })
    }
    vm.policy.maxConcurrency = explicitConcurrency
      ? rawConcurrency
      : Number(routing?.concurrency?.default_max_per_account ?? 2)
    vm.policy.concurrencyOverride = explicitConcurrency
    vm.policy.maxRpm = explicitRpm ? rawRpm : Number(routing?.concurrency?.default_max_rpm ?? 0)
    vm.policy.rpmOverride = explicitRpm
  }

  return vm
}

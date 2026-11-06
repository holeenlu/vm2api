/**
 * 执行契约 v1（docs/ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md 第 5 节）的控制面定义。
 * Worker 的同一份定义在 worker/internal/codexgateway/events_types.go，两边由
 * test/fixtures/executor-contract/events.json 对齐。
 */
import crypto from 'node:crypto'
import { canonicalJson } from '../gateway-worker/gateway-auth.mjs'

export const EXECUTOR_CONTRACT_VERSION = 1

export const EXECUTOR_EVENT_TYPES = Object.freeze([
  // 一次分发的最终结果，载荷与回执相同（含 payload_hash）
  'request.finalized',
  // 本实例全部账号的凭据与 BPS 终态快照（整体替换）
  'account.state',
  // 有变化的账号额度快照
  'account.quota',
  // 一次 BPS 恢复探测记录
  'probe.recorded',
])

export const EXECUTOR_EVENTS_MODES = Object.freeze(['off', 'shadow', 'primary'])

/**
 * 控制面使用事件的方式（KIN_EXECUTOR_EVENTS）：
 *   off（默认）不拉取；shadow 拉取并与回执、心跳比对，不生效；primary 以事件为主来源，心跳中的同类字段不再写入。
 */
export function executorEventsMode(env = process.env) {
  const mode = String(env.KIN_EXECUTOR_EVENTS || '')
    .trim()
    .toLowerCase()
  return EXECUTOR_EVENTS_MODES.includes(mode) ? mode : 'off'
}

const EVENT_ID = /^evt_([A-Za-z0-9]+)_([1-9][0-9]*)$/

/**
 * 事件载荷摘要，与 Worker canonicalPayload 同口径：按键排序的紧凑 JSON。Go encoding/json 总是把 U+2028/U+2029
 * 转义为 \u2028/\u2029，这里做同样处理（R1 审查 P1-2）；超过 2^53 的整数无法在 JS 中精确还原，按无效事件处理。
 */
export function executorPayloadHash(payload) {
  const raw = canonicalJson(payload)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** 校验事件信封与载荷摘要；expected 可限定实例与流。 */
export function validateExecutorEvent(event, expected = {}) {
  const fail = (code) => ({ ok: false, code })
  if (!event || typeof event !== 'object' || Array.isArray(event)) return fail('event_not_object')
  const { event_id: id, stream_id: stream, instance_id: instance, seq, type, version, occurred_at: at } = event
  if (typeof stream !== 'string' || !/^[A-Za-z0-9]+$/.test(stream)) return fail('invalid_stream_id')
  if (typeof instance !== 'string' || !instance) return fail('invalid_instance_id')
  if (!Number.isSafeInteger(seq) || seq <= 0) return fail('invalid_seq')
  const match = EVENT_ID.exec(String(id || ''))
  if (!match || match[1] !== stream || Number(match[2]) !== seq) return fail('invalid_event_id')
  if (!EXECUTOR_EVENT_TYPES.includes(type)) return fail('unknown_event_type')
  if (version !== EXECUTOR_CONTRACT_VERSION) return fail('unsupported_version')
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return fail('invalid_occurred_at')
  if (event.subject != null && (typeof event.subject !== 'object' || Array.isArray(event.subject)))
    return fail('invalid_subject')
  if (event.payload === undefined || event.payload === null) return fail('missing_payload')
  if (executorPayloadHash(event.payload) !== event.payload_sha256) return fail('payload_hash_mismatch')
  if (expected.instanceId && instance !== expected.instanceId) return fail('instance_mismatch')
  if (expected.streamId && stream !== expected.streamId) return fail('stream_mismatch')
  return { ok: true }
}

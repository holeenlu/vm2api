export function relayError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}
export function moneyMicros(value, { negative = false } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || (!negative && n < 0)) throw relayError('invalid_amount', '金额必须是有效非负数')
  const micros = Math.round(n * 1_000_000)
  if (!Number.isSafeInteger(micros)) throw relayError('invalid_amount', '金额超出范围')
  return micros
}
export function integer(value, min, max, field) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw relayError('invalid_' + field, field + ' 超出允许范围')
  return n
}
export function strings(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim()))
    throw relayError('invalid_' + field, field + ' 必须是非空字符串数组')
  return [...new Set(value.map((v) => v.trim()))]
}
export function audit(db, actor, action, target, before, after, reason = '') {
  db.prepare(
    'INSERT INTO operation_audit (actor,action,target,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    String(actor || 'system'),
    action,
    String(target),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    String(reason).slice(0, 1000),
    new Date().toISOString(),
  )
}

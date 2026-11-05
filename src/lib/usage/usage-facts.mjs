/**
 * Canonical usage facts shared by reporting and settlement adapters.
 * Unknown numeric values stay null; this layer never turns missing evidence
 * into zero.
 */
const NON_NEGATIVE_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'request_count',
])

function nonNegative(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function text(value) {
  const result = String(value ?? '').trim()
  return result || null
}

function cost(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null
}

export function normalizeUsageFacts(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const facts = {}
  for (const field of NON_NEGATIVE_FIELDS) facts[field] = nonNegative(source[field])
  facts.input_tokens ??= nonNegative(source.prompt_tokens)
  facts.output_tokens ??= nonNegative(source.completion_tokens)
  facts.cache_read_tokens ??= nonNegative(source.cache_read_input_tokens)
  facts.cache_write_tokens ??= nonNegative(source.cache_creation_input_tokens)
  facts.request_count = facts.request_count ?? 1
  facts.total_tokens =
    facts.input_tokens != null && facts.output_tokens != null ? facts.input_tokens + facts.output_tokens : null
  facts.cost_usd = cost(source.cost_usd ?? source.actual_cost_usd ?? source.total_cost)
  facts.success = booleanOrNull(source.success ?? (source.status != null ? Number(source.status) < 400 : null))
  facts.priced = booleanOrNull(source.priced ?? (facts.cost_usd != null ? true : null))
  facts.model = text(source.model ?? source.response_model ?? source.upstream_model)
  facts.provider = text(source.provider ?? source.platform)
  facts.occurred_at = text(source.occurred_at ?? source.created_at ?? source.started_at)
  facts.request_id = text(source.request_id ?? source.id)
  facts.usage_complete = facts.input_tokens != null && facts.output_tokens != null
  return Object.freeze(facts)
}

export function usageFactsFromLog(row) {
  return normalizeUsageFacts({
    ...row,
    input_tokens: row?.input_tokens ?? row?.prompt_tokens,
    output_tokens: row?.output_tokens ?? row?.completion_tokens,
    cache_read_tokens: row?.cache_read_tokens ?? row?.cache_read_input_tokens,
    cache_write_tokens: row?.cache_write_tokens ?? row?.cache_creation_input_tokens,
    cost_usd: row?.actual_cost_usd ?? row?.cost_usd ?? row?.total_cost,
    occurred_at: row?.created_at ?? row?.started_at,
  })
}

import { getGptModelPolicy } from './gpt-model-policy.mjs'
import { gptContextWindowOverride } from './gpt-ids.mjs'

const DEFAULT_CONTEXT_WINDOW = 272_000
const DEFAULT_OUTPUT_TOKENS = 16_384
const INPUT_TRIGGER_RATIO = 0.9
const INPUT_TARGET_RATIO = 0.72
const BYTES_PER_TOKEN = 4

function modelId(model) {
  return (
    String(model || '')
      .trim()
      .split('/')
      .filter(Boolean)
      .pop() || ''
  )
}

function positive(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function outputBudget(body) {
  return Math.min(
    128_000,
    positive(body?.max_output_tokens) ||
      positive(body?.max_completion_tokens) ||
      positive(body?.max_tokens) ||
      DEFAULT_OUTPUT_TOKENS,
  )
}

function policyRow(model) {
  const id = modelId(model)
  const models = getGptModelPolicy()?.models || {}
  return models[id] || Object.entries(models).find(([key]) => key.toLowerCase() === id.toLowerCase())?.[1] || null
}

export function codexContextBudget(model, body = {}) {
  const id = modelId(model)
  const row = policyRow(id)
  const override = gptContextWindowOverride(id)
  const contextWindow =
    override ||
    positive(row?.codex_metadata?.context_window) ||
    positive(row?.catalog?.context_window) ||
    positive(row?.capabilities?.context_window) ||
    DEFAULT_CONTEXT_WINDOW
  const maxContextWindow = Math.max(
    contextWindow,
    positive(row?.codex_metadata?.max_context_window) || positive(row?.catalog?.max_context_window) || contextWindow,
  )
  const outputTokens = outputBudget(body)
  const inputTriggerTokens = Math.max(16_384, Math.floor(contextWindow * INPUT_TRIGGER_RATIO - outputTokens))
  const inputTargetTokens = Math.max(8_192, Math.floor(contextWindow * INPUT_TARGET_RATIO - outputTokens))
  return { model: id, contextWindow, maxContextWindow, outputTokens, inputTriggerTokens, inputTargetTokens }
}

export function estimateCodexInputTokens(input) {
  if (input == null) return 0
  return Math.ceil(Buffer.byteLength(JSON.stringify(input)) / BYTES_PER_TOKEN)
}

function itemKind(item) {
  const type = String(item?.type || '')
  if (type === 'reasoning') return 'reasoning'
  if (
    /^(function_call|function_call_output|computer_call|computer_call_output|web_search_call|item_reference)$/.test(
      type,
    )
  )
    return 'tool'
  return 'message'
}

/**
 * Remove old reasoning/tool items until the request is below the model's
 * effective input budget. User/system messages are retained as anchors.
 */
export function compactCodexInput(body, { force = false } = {}) {
  if (!body || body.previous_response_id || !Array.isArray(body.input)) return null
  const budget = codexContextBudget(body.model, body)
  const originalTokens = estimateCodexInputTokens(body.input)
  if (!force && originalTokens <= budget.inputTriggerTokens) return null

  const removable = []
  const protectedFrom = Math.max(0, body.input.length - 18)
  for (let index = 0; index < protectedFrom; index += 1) {
    const kind = itemKind(body.input[index])
    if (kind === 'reasoning' || kind === 'tool') removable.push(index)
  }
  if (!removable.length) return null

  const keep = new Set(body.input.keys())
  let nextInput = body.input.slice()
  for (const index of removable) {
    keep.delete(index)
    nextInput = body.input.filter((_item, itemIndex) => keep.has(itemIndex))
    if (estimateCodexInputTokens(nextInput) <= budget.inputTargetTokens) break
  }
  if (nextInput.length === body.input.length) return null
  const retainedTokens = estimateCodexInputTokens(nextInput)
  const nextBody = { ...body, input: nextInput }
  return {
    body: nextBody,
    info: {
      model: budget.model,
      context_window: budget.contextWindow,
      max_context_window: budget.maxContextWindow,
      input_trigger_tokens: budget.inputTriggerTokens,
      input_target_tokens: budget.inputTargetTokens,
      original_tokens: originalTokens,
      retained_tokens: retainedTokens,
      original_items: body.input.length,
      retained_items: nextInput.length,
      removed_items: body.input.length - nextInput.length,
      preflight: !force,
    },
  }
}

export function codexContextCompactionRequired(model, body = {}) {
  const budget = codexContextBudget(model, body)
  return {
    ok: false,
    committed: false,
    explicitFailure: true,
    status: 409,
    body: {
      error: {
        type: 'invalid_request_error',
        code: 'codex_context_compaction_required',
        message: 'Codex 会话上下文已接近模型上限，请移除 previous_response_id，携带压缩后的完整 input 历史重新提交。',
        details: {
          action: 'resend_compacted_history',
          remove: 'previous_response_id',
          model: budget.model,
          context_window: budget.contextWindow,
          max_context_window: budget.maxContextWindow,
        },
      },
    },
  }
}

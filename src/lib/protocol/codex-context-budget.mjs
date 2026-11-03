import { effectiveGptContextWindow, getGptModelPolicy } from './gpt-model-policy.mjs'

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
  const contextWindow = effectiveGptContextWindow(id, row, DEFAULT_CONTEXT_WINDOW)
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

/** 单项在数组里占的 JSON 字节数；undefined 在数组中序列化为 `null`。 */
function itemBytes(item) {
  const json = JSON.stringify(item)
  return json === undefined ? 4 : Buffer.byteLength(json)
}

/**
 * 由各项字节数还原 `JSON.stringify(array)` 的 token 估算：两个方括号，
 * 加各项字节数，再加 count-1 个逗号。与 estimateCodexInputTokens 逐字节等价。
 */
function arrayTokens(sumBytes, count) {
  return Math.ceil((2 + sumBytes + Math.max(0, count - 1)) / BYTES_PER_TOKEN)
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

function toolPairKey(item) {
  const type = String(item?.type || '')
  const callId = String(item?.call_id || item?.id || '').trim()
  if (!callId) return null
  if (type === 'function_call' || type === 'function_call_output') return `function:${callId}`
  if (type === 'custom_tool_call' || type === 'custom_tool_call_output') return `custom:${callId}`
  if (type === 'computer_call' || type === 'computer_call_output') return `computer:${callId}`
  return null
}

function toolPairIndexes(input) {
  const calls = new Map()
  const outputs = new Map()
  for (let index = 0; index < input.length; index += 1) {
    const type = String(input[index]?.type || '')
    const key = toolPairKey(input[index])
    if (!key) continue
    const target = type.endsWith('_output') ? outputs : calls
    const indexes = target.get(key) || []
    indexes.push(index)
    target.set(key, indexes)
  }
  const orphanOutputs = new Set()
  for (const [key, indexes] of outputs) {
    if (!calls.has(key)) for (const index of indexes) orphanOutputs.add(index)
  }
  return { calls, outputs, orphanOutputs }
}

/**
 * Remove old reasoning/tool items until the request is below the model's
 * effective input budget. User/system messages are retained as anchors.
 */
export function compactCodexInput(body, { force = false } = {}) {
  if (!body || body.previous_response_id || !Array.isArray(body.input)) return null
  const budget = codexContextBudget(body.model, body)
  const originalInput = body.input
  const originalTokens = estimateCodexInputTokens(originalInput)
  const pairs = toolPairIndexes(originalInput)
  const orphanToolOutputs = pairs.orphanOutputs
  const sourceInput = orphanToolOutputs.size
    ? originalInput.filter((_item, index) => !orphanToolOutputs.has(index))
    : originalInput
  if (!force && originalTokens <= budget.inputTriggerTokens && !orphanToolOutputs.size) return null

  const shouldCompact = force || originalTokens > budget.inputTriggerTokens
  const removableUnits = []
  const protectedFrom = Math.max(0, sourceInput.length - 18)
  const sourcePairs = orphanToolOutputs.size ? toolPairIndexes(sourceInput) : pairs
  const visited = new Set()
  // Walk history in order and treat each call/result group as one removal unit.
  // A result in the protected tail also protects its older call.
  if (shouldCompact) {
    for (let index = 0; index < protectedFrom; index += 1) {
      const key = toolPairKey(sourceInput[index])
      if (key) {
        if (visited.has(key)) continue
        visited.add(key)
        const group = [...(sourcePairs.calls.get(key) || []), ...(sourcePairs.outputs.get(key) || [])]
        if (group.every((itemIndex) => itemIndex < protectedFrom)) removableUnits.push(group)
      } else if (itemKind(sourceInput[index]) !== 'message') {
        removableUnits.push([index])
      }
    }
  }
  if (!removableUnits.length && !orphanToolOutputs.size) return null

  // 逐项序列化一次，之后每删一项只做减法。先前的写法在循环里重建整个
  // 数组并把剩余全历史重新 JSON.stringify，开销随删除条数呈平方增长；
  // 会话过载恢复正是对最长的历史走这条路径（force=true），生产 profile 里
  // JSON 序列化因此占到主线程 CPU 的三成左右。
  const sizes = sourceInput.map(itemBytes)
  let sumBytes = sizes.reduce((total, bytes) => total + bytes, 0)
  let count = sourceInput.length
  const removed = new Set()
  for (const unit of removableUnits) {
    for (const index of unit) {
      removed.add(index)
      sumBytes -= sizes[index]
      count -= 1
    }
    if (arrayTokens(sumBytes, count) <= budget.inputTargetTokens) break
  }
  if (!removed.size && !orphanToolOutputs.size) return null
  const nextInput = sourceInput.filter((_item, itemIndex) => !removed.has(itemIndex))
  const retainedTokens = arrayTokens(sumBytes, count)
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
      original_items: originalInput.length,
      retained_items: nextInput.length,
      removed_items: originalInput.length - nextInput.length,
      orphan_tool_outputs_removed: orphanToolOutputs.size,
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

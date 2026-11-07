import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { canReplayCodex } from '../../src/lib/pool/codex-replay.mjs'
import { isRetryableSameCodexAccount } from '../../src/lib/protocol/handle-codex.mjs'

// 重放判定契约（审计阶段 2 W13）：Node 与 Go Worker 共读 test/fixtures/executor-contract/replay-matrix.json，
// 这里锁定 Codex VM 路径的判定；Go 侧见 worker/internal/codexgateway/replay_matrix_test.go。
const matrix = JSON.parse(
  fs.readFileSync(new URL('../fixtures/executor-contract/replay-matrix.json', import.meta.url), 'utf8'),
)

function resultOf(entry) {
  let body
  try {
    body = JSON.parse(entry.body)
  } catch {
    body = { error: { message: entry.body } }
  }
  return {
    ok: false,
    status: entry.status,
    sendState: entry.send_state,
    ...(entry.transport_error ? { transportError: true } : {}),
    body,
  }
}

test('replay matrix is well formed and documents every executor divergence', () => {
  assert.equal(matrix.version, 1)
  const ids = new Set()
  for (const entry of matrix.cases) {
    assert.ok(!ids.has(entry.id), `duplicate case ${entry.id}`)
    ids.add(entry.id)
    assert.ok(['sent', 'not_sent', 'ambiguous'].includes(entry.send_state), entry.id)
    assert.equal(typeof entry.codex_vm?.replay, 'boolean', entry.id)
    const gateway = entry.gateway_worker
    // 两个执行器的“是否换号”不一致时必须写明原因
    const vmSwitches = entry.codex_vm.replay && !entry.codex_vm.same_account_retry
    if (!gateway || gateway.switch !== vmSwitches || gateway.same_account_retry !== entry.codex_vm.same_account_retry)
      assert.ok(entry.divergence, `${entry.id} differs between executors without a divergence note`)
  }
})

for (const entry of matrix.cases) {
  test(`codex VM replay decision matches the contract: ${entry.id}`, () => {
    const result = resultOf(entry)
    assert.equal(canReplayCodex(result), entry.codex_vm.replay, 'replay')
    assert.equal(isRetryableSameCodexAccount(result), entry.codex_vm.same_account_retry, 'same_account_retry')
  })
}

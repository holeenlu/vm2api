import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import {
  compileAccountErrorProtection,
  errorFactsFromResult,
  recordProtectionFailure,
  recordProtectionSuccess,
} from './account-error-protection.mjs'
import { codexSendState, codexFeedbackKind } from './codex-replay.mjs'

/**
 * SQLite is the durable source; rebuild this lightweight view per request.
 * 读写经运行态仓储的异步方法（R6 B7c）。候选准入的同步排序（orderCodexSessionSlots 的 protectionUntil 回调）
 * 用 `frozenUntil()` 先读好的结果。
 */
export class CodexAccountProtection {
  constructor(db) {
    this.settings = new SettingsRepo(db)
    this.repo = new AccountRuntimeRepo(db)
  }
  policy() {
    return compileAccountErrorProtection(this.settings.get('account_error_protection', {}))
  }
  async capture(vmId, credentialGeneration) {
    const compiled = this.policy()
    let snapshot = await this.repo.getProtectionState(vmId)
    if (
      compiled.policy.enabled &&
      snapshot?.state &&
      (snapshot.state.credentialGeneration !== credentialGeneration ||
        snapshot.state.policyFingerprint !== compiled.fingerprint)
    ) {
      const state = {
        policyFingerprint: compiled.fingerprint,
        credentialGeneration,
        generation: (snapshot.state.generation || 0) + 1,
        count: 0,
        frozenUntil: 0,
      }
      await this.repo.compareAndSwapProtectionState(vmId, { expectedGeneration: snapshot.generation, state })
      snapshot = await this.repo.getProtectionState(vmId)
    }
    return { compiled, credentialGeneration, epoch: snapshot?.state?.generation || 0 }
  }
  async until(vmId, credentialGeneration, now = Date.now()) {
    const compiled = this.policy()
    if (!compiled.policy.enabled) return 0
    return frozenUntilOf(compiled, (await this.repo.getProtectionState(vmId))?.state, credentialGeneration, now)
  }
  /**
   * 候选准入前一次读齐：`id → frozenUntil`（只含仍冻结的账号）。保护关闭时不读库、不算凭据代次。
   * `generationOf(id)` 给出该账号当前的凭据代次。
   */
  async frozenUntil(ids, generationOf, now = Date.now()) {
    const out = new Map()
    const compiled = this.policy()
    if (!compiled.policy.enabled) return out
    for (const id of ids || []) {
      const state = (await this.repo.getProtectionState(id))?.state
      if (!state) continue
      const until = frozenUntilOf(compiled, state, generationOf(id), now)
      if (until) out.set(id, until)
    }
    return out
  }
  async observe(vmId, result, guard) {
    if (!guard?.compiled.policy.enabled || this.policy().fingerprint !== guard.compiled.fingerprint) return null
    if (codexSendState(result) !== 'sent' || !codexFeedbackKind(result)) return null
    if (!(await this.repo.getProtectionState(vmId))) await this.repo.upsert({ account_id: vmId, vm_id: vmId })
    const current = await this.repo.getProtectionState(vmId)
    if (!current) return null
    if ((current.state?.generation || 0) !== guard.epoch) return null
    if (current.state && current.state.credentialGeneration !== guard.credentialGeneration) return null
    const outcome = result.ok
      ? { state: recordProtectionSuccess(current.state), frozen: false }
      : recordProtectionFailure(guard.compiled, current.state, errorFactsFromResult(result, { provider: 'openai' }), {
          credentialGeneration: guard.credentialGeneration,
        })
    if (
      (await this.repo.compareAndSwapProtectionState(vmId, {
        expectedGeneration: current.generation,
        state: outcome.state,
      })) == null
    )
      return null
    return outcome.frozen ? outcome.state : null
  }
}

function frozenUntilOf(compiled, state, credentialGeneration, now) {
  return state?.policyFingerprint === compiled.fingerprint &&
    state?.credentialGeneration === credentialGeneration &&
    Number(state.frozenUntil) > now
    ? Number(state.frozenUntil)
    : 0
}

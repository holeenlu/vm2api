import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { AccountRuntimeRepo } from '../db/repos/account-runtime-repo.mjs'
import {
  compileAccountErrorProtection,
  errorFactsFromResult,
  recordProtectionFailure,
  recordProtectionSuccess,
} from './account-error-protection.mjs'
import { codexSendState, codexFeedbackKind } from './codex-replay.mjs'

/** SQLite is the durable source; rebuild this lightweight view per request. */
export class CodexAccountProtection {
  constructor(db) {
    this.settings = new SettingsRepo(db)
    this.repo = new AccountRuntimeRepo(db)
  }
  policy() {
    return compileAccountErrorProtection(this.settings.get('account_error_protection', {}))
  }
  capture(vmId, credentialGeneration) {
    const compiled = this.policy()
    let snapshot = this.repo.getProtectionState(vmId)
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
      this.repo.compareAndSwapProtectionState(vmId, { expectedGeneration: snapshot.generation, state })
      snapshot = this.repo.getProtectionState(vmId)
    }
    return { compiled, credentialGeneration, epoch: snapshot?.state?.generation || 0 }
  }
  until(vmId, credentialGeneration, now = Date.now()) {
    const compiled = this.policy()
    if (!compiled.policy.enabled) return 0
    const state = this.repo.getProtectionState(vmId)?.state
    return state?.policyFingerprint === compiled.fingerprint &&
      state?.credentialGeneration === credentialGeneration &&
      Number(state.frozenUntil) > now
      ? Number(state.frozenUntil)
      : 0
  }
  observe(vmId, result, guard) {
    if (!guard?.compiled.policy.enabled || this.policy().fingerprint !== guard.compiled.fingerprint) return null
    if (codexSendState(result) !== 'sent' || !codexFeedbackKind(result)) return null
    if (!this.repo.getProtectionState(vmId)) this.repo.upsert({ account_id: vmId, vm_id: vmId })
    const current = this.repo.getProtectionState(vmId)
    if ((current.state?.generation || 0) !== guard.epoch) return null
    if (current.state && current.state.credentialGeneration !== guard.credentialGeneration) return null
    const outcome = result.ok
      ? { state: recordProtectionSuccess(current.state), frozen: false }
      : recordProtectionFailure(guard.compiled, current.state, errorFactsFromResult(result, { provider: 'openai' }), {
          credentialGeneration: guard.credentialGeneration,
        })
    if (
      this.repo.compareAndSwapProtectionState(vmId, { expectedGeneration: current.generation, state: outcome.state }) ==
      null
    )
      return null
    return outcome.frozen ? outcome.state : null
  }
}

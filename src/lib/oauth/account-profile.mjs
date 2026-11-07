/** Account display metadata. Profile reads use the slot worker and its bound egress. */
import fs from 'node:fs'
import path from 'node:path'
import { resolveVendorAccountName } from '../vendor/vendor-account-name.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { atomicWriteJson, withVmLock } from '../vm/vm-file.mjs'
import { applySlotNameFromAuthorization } from '../vm/slot-name.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { hasCredentialPresence } from './oauth-credentials.mjs'
import { flattenOauthIdentity, SUBSCRIPTION_METADATA_KEYS } from './oauth-identity.mjs'
import { createOAuthExecutionContext } from './oauth-execution-context.mjs'

/** Store only observed fields. A new successful snapshot clears fields omitted by the provider. */
export async function persistAccountProfile(vmPath, body, expected, { now = Date.now() } = {}) {
  const identity = flattenOauthIdentity(body)
  if (!identity.account_uuid && !identity.org_uuid && !identity.subscription_type && !identity.billing_type)
    return { ok: false, reason: 'profile_empty' }
  return withVmLock(vmPath, async () => {
    if (!fs.existsSync(vmPath)) return { ok: false, reason: 'vm_not_found' }
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    const current = vm.claude || {}
    for (const key of ['_token_version', 'account_uuid', 'org_uuid', 'mode', 'scope']) {
      if (current[key] !== expected[key]) return { ok: false, reason: 'credential_changed' }
    }
    for (const key of ['account_uuid', 'org_uuid']) {
      if (identity[key] && expected[key] && identity[key] !== expected[key])
        return { ok: false, reason: 'profile_identity_mismatch' }
    }
    vm.claude = { ...current }
    for (const key of ['email', 'account_uuid', 'org_uuid']) if (identity[key]) vm.claude[key] = identity[key]
    for (const key of SUBSCRIPTION_METADATA_KEYS) delete vm.claude[key]
    for (const key of ['subscription_type', 'rate_limit_tier', 'billing_type'])
      if (identity[key]) vm.claude[key] = identity[key]
    vm.claude.subscription_updated_at = new Date(now).toISOString()
    vm.updated_at = vm.claude.subscription_updated_at
    applySlotNameFromAuthorization(path.resolve(path.dirname(vmPath), '..'), vm, identity.email)
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
    await resolveVendorAccountName(vm, identity.email)
    return { ok: true, updated_at: vm.claude.subscription_updated_at, vm }
  })
}

/** Called only on authorization and explicit refresh, never on list polling or inference. */
export async function refreshAccountProfile(projectRoot, vmId, { slotOauth = runSlotOauth } = {}) {
  try {
    const vmPath = path.join(projectRoot, 'vms', `${vmId}.json`)
    if (!fs.existsSync(vmPath)) return { ok: false, reason: 'vm_not_found' }
    const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
    if (isCodexVm(vm)) return { ok: false, reason: 'profile_scope_required' }
    const expected = vm.claude || {}
    const oauthContext = createOAuthExecutionContext({ projectRoot, vm, exec: { vmId } })
    const credentialFacts = oauthContext.credential
    if (!credentialFacts.profileAllowed) return { ok: false, reason: 'profile_scope_required' }
    if (!credentialFacts.hasCredential || !hasCredentialPresence(expected))
      return { ok: false, reason: 'credential_required' }
    const response = await slotOauth(
      {
        vmId: oauthContext.vmId,
        vm,
        projectRoot: oauthContext.projectRoot,
        proxyUrl: oauthContext.proxyUrl,
        homeDir: path.join(projectRoot, 'vms', vmId, 'cli-home'),
      },
      'profile',
      { timeoutMs: 15000 },
    )
    if (!response?.ok) return { ok: false, reason: 'profile_fetch_failed', status: response?.status || 0 }
    return await persistAccountProfile(vmPath, response.body, expected)
  } catch {
    return { ok: false, reason: 'profile_fetch_failed' }
  }
}

import { credentialFactsOfVm } from './credential-facts.mjs'
import { proxyBindingOfVm } from '../vm/proxy-binding.mjs'

/** Immutable OAuth execution facts shared by profile, quota and refresh adapters. */
export function createOAuthExecutionContext({ projectRoot = null, vm = null, exec = null, proxyUrl = null } = {}) {
  const target = vm || exec?.vm || null
  return Object.freeze({
    projectRoot: projectRoot || exec?.projectRoot || null,
    vmId: exec?.vmId || target?.id || null,
    credential: credentialFactsOfVm(target || {}),
    proxy: proxyBindingOfVm(target || {}),
    proxyUrl: proxyUrl ?? exec?.proxyUrl ?? target?.proxy?.url ?? null,
  })
}

import path from 'node:path'
import { isApiKeyMode, isOfficialSetupTokenMode, isSetupTokenMode } from './credential-mode.mjs'

/** Shared route facts for panel OAuth operations. No token exchange happens here. */
export function oauthVmPaths(projectRoot, vmId) {
  const slotDir = path.join(projectRoot, 'vms', vmId)
  return Object.freeze({
    vmPath: path.join(projectRoot, 'vms', `${vmId}.json`),
    homeDir: path.join(slotDir, 'cli-home'),
    slotDir,
  })
}

export function oauthCredentialState(vm = {}, credential = {}) {
  const mode = vm?.claude?.mode || credential?.mode || credential?.type || null
  return Object.freeze({
    mode,
    api_key: isApiKeyMode(mode),
    official_setup_token: isOfficialSetupTokenMode(mode),
    setup_token: isSetupTokenMode(mode),
    refreshable:
      !isApiKeyMode(mode) && !isOfficialSetupTokenMode(mode) && !(isSetupTokenMode(mode) && !vm?.claude?.has_refresh),
  })
}

export function oauthCredentialView(vm = {}, credential = {}) {
  const present = credential && Object.keys(credential).length > 0
  return Object.freeze({
    vm_id: vm.id || null,
    has_token: !!(credential.access_token || credential.refresh_token || credential.api_key),
    source: present ? 'slot-credentials.json' : null,
  })
}

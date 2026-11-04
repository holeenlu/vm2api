import {
  canReadAccountProfile,
  canRefreshCredential,
  credentialModeFromOauth,
  credentialModeOfVm,
  isOfficialSetupTokenMode,
} from './credential-mode.mjs'

/** Canonical credential facts for profile, quota and refresh adapters. */
export function credentialFactsOfVm(vm = {}) {
  const credential = vm?.claude || {}
  const mode = credentialModeOfVm(vm)
  const access = !!(credential.access_token || credential.has_access)
  const refresh = !!(credential.refresh_token || credential.has_refresh)
  return Object.freeze({
    mode,
    access,
    refresh,
    hasCredential: access || refresh || !!credential.session_key || !!credential.api_key,
    profileAllowed: canReadAccountProfile({ ...credential, mode }),
    refreshAllowed: canRefreshCredential(mode),
    inferenceOnly: isOfficialSetupTokenMode(mode),
    accountUuid: credential.account_uuid || null,
    orgUuid: credential.org_uuid || null,
  })
}

export function credentialFactsFromOauth(oauth = {}) {
  const mode = credentialModeFromOauth(oauth)
  const access = !!(oauth.access_token || oauth.accessToken)
  const refresh = !!(oauth.refresh_token || oauth.refreshToken)
  return Object.freeze({
    mode,
    access,
    refresh,
    hasCredential: access || refresh || !!oauth.session_key || !!oauth.api_key,
    profileAllowed: canReadAccountProfile({ ...oauth, mode }),
    refreshAllowed: canRefreshCredential(mode),
    inferenceOnly: isOfficialSetupTokenMode(mode),
    accountUuid: oauth.account_uuid || null,
    orgUuid: oauth.org_uuid || null,
  })
}

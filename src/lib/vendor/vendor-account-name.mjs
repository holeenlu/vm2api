import { getDb, isDbOpen } from '../db/database.mjs'
import { findAuthorizationNamedAccount, setResourceNameConfigStamped } from './repos/resources-repo.mjs'

/** Resolve a blank supplier account name once an authorization supplies its email. */
export function resolveVendorAccountName(vm, email, db = isDbOpen() ? getDb() : null) {
  const name = typeof email === 'string' ? email.trim() : ''
  if (!db || !vm?.vendor_account_resource_id || !name) return false
  const account = findAuthorizationNamedAccount(db, vm.vendor_account_resource_id, vm.id)
  if (!account) return false
  const config = JSON.parse(account.config_json)
  if (config.name_from_authorization !== true) return false
  delete config.name_from_authorization
  setResourceNameConfigStamped(db, name, JSON.stringify(config), new Date().toISOString(), account.id)
  return true
}

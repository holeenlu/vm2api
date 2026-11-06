import { getDb, isDbOpen } from '../db/database.mjs'
import {
  findAuthorizationNamedAccount,
  findAuthorizationNamedAccountSync,
  setResourceNameConfigStamped,
  setResourceNameConfigStampedSync,
} from './repos/resources-repo.mjs'

const emailName = (email) => (typeof email === 'string' ? email.trim() : '')

/** 账号仍等待按授权邮箱命名时返回去掉标记后的配置，否则返回 null。 */
function namedConfig(account) {
  if (!account) return null
  const config = JSON.parse(account.config_json)
  if (config.name_from_authorization !== true) return null
  delete config.name_from_authorization
  return config
}

/** Resolve a blank supplier account name once an authorization supplies its email. */
export async function resolveVendorAccountName(vm, email, db = isDbOpen() ? getDb() : null) {
  const name = emailName(email)
  if (!db || !vm?.vendor_account_resource_id || !name) return false
  const account = await findAuthorizationNamedAccount(db, vm.vendor_account_resource_id, vm.id)
  const config = namedConfig(account)
  if (!config) return false
  await setResourceNameConfigStamped(db, name, JSON.stringify(config), new Date().toISOString(), account.id)
  return true
}

/**
 * R6 临时同步出口（B7 删除）：oauth-credentials 的 persistOauthToVm 在凭据刷新链路上同步调用。
 * 与 resolveVendorAccountName 共用判定（namedConfig）与 SQL。
 */
export function resolveVendorAccountNameSync(vm, email, db = isDbOpen() ? getDb() : null) {
  const name = emailName(email)
  if (!db || !vm?.vendor_account_resource_id || !name) return false
  const account = findAuthorizationNamedAccountSync(db, vm.vendor_account_resource_id, vm.id)
  const config = namedConfig(account)
  if (!config) return false
  setResourceNameConfigStampedSync(db, name, JSON.stringify(config), new Date().toISOString(), account.id)
  return true
}

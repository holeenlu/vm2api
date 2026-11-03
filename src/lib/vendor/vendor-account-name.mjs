import { getDb, isDbOpen } from '../db/database.mjs'

/** Resolve a blank supplier account name once an authorization supplies its email. */
export function resolveVendorAccountName(vm, email, db = isDbOpen() ? getDb() : null) {
  const name = typeof email === 'string' ? email.trim() : ''
  if (!db || !vm?.vendor_account_resource_id || !name) return false
  const account = db
    .prepare(`SELECT a.id,a.config_json FROM vendor_resources a
    JOIN vendor_resources v ON v.id=json_extract(a.config_json,'$.vm_resource_id')
      AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
    WHERE a.id=? AND a.resource_type='account' AND a.status<>'archived' AND v.status<>'archived'
      AND json_extract(v.config_json,'$.runtime_vm_id')=?`)
    .get(vm.vendor_account_resource_id, vm.id)
  if (!account) return false
  const config = JSON.parse(account.config_json)
  if (config.name_from_authorization !== true) return false
  delete config.name_from_authorization
  db.prepare('UPDATE vendor_resources SET name=?,config_json=?,updated_at=? WHERE id=?').run(
    name,
    JSON.stringify(config),
    new Date().toISOString(),
    account.id,
  )
  return true
}

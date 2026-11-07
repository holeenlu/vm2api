import { getDb, isDbOpen } from '../db/database.mjs'
import { usagePoolEnabled, usageRead } from '../db/sqlite-pool.mjs'

// Supplier usage reports aggregate whole account histories and take hundreds of milliseconds on busy
// accounts. On the shared database they run on the read-only worker pool so the gateway thread keeps
// serving; other connections (tests, tools) and pool failures read inline. Validate input before calling
// so input errors keep their VendorError type instead of crossing the thread boundary as plain text.
export async function pooledVendorRead(db, method, args, inline) {
  if (usagePoolEnabled() && isDbOpen() && db === getDb()) {
    try {
      return await usageRead({ kind: 'vendor', method, args })
    } catch (err) {
      console.warn(`[sqlite-pool] vendor.${method}: ${err?.message || err}`)
    }
  }
  return inline()
}

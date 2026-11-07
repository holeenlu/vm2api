// 计费在途记录（billing_inflight，迁移 131）的仓储。调用方注入数据库句柄并负责事务边界；经 DbClient 异步访问。
import { dbClient } from '../../db/db-client.mjs'

const INSERT_SQL = `INSERT OR IGNORE INTO billing_inflight
  (request_id,boot_id,wallet_key,user_id,api_key_id,group_id,model,context_json,started_at)
  VALUES (?,?,?,?,?,?,?,?,?)`
const DELETE_SQL = 'DELETE FROM billing_inflight WHERE request_id=?'
const NOTE_DISPATCH_SQL = 'UPDATE billing_inflight SET gateway_instance_id=?, dispatch_id=? WHERE request_id=?'
const COUNT_WALLET_SQL = 'SELECT COUNT(*) AS n FROM billing_inflight WHERE wallet_key=? AND boot_id=?'
const ORPHANS_SQL = `SELECT * FROM billing_inflight WHERE boot_id<>? OR started_at<?
  ORDER BY started_at LIMIT ?`
const SETTLED_SQL = `SELECT
  EXISTS(SELECT 1 FROM billing_charges WHERE request_id=?) AS charged,
  EXISTS(SELECT 1 FROM usage_logs WHERE request_id=?) AS logged`

export async function insertInflight(db, row) {
  await dbClient(db).run(
    INSERT_SQL,
    row.request_id,
    row.boot_id,
    row.wallet_key,
    row.user_id ?? null,
    row.api_key_id ?? null,
    row.group_id == null ? null : String(row.group_id),
    row.model ?? null,
    row.context_json,
    row.started_at,
  )
}

export async function deleteInflight(db, requestId) {
  return (await dbClient(db).run(DELETE_SQL, requestId)).changes > 0
}

export async function noteInflightDispatch(db, requestId, instanceId, dispatchId) {
  await dbClient(db).run(NOTE_DISPATCH_SQL, instanceId ?? null, dispatchId ?? null, requestId)
}

/** 本进程（boot_id）里该钱包仍在途的请求数；其他进程留下的孤儿行由扫描处理，不计入。 */
export async function countWalletInflight(db, walletKey, bootId) {
  return Number((await dbClient(db).one(COUNT_WALLET_SQL, walletKey, bootId))?.n || 0)
}

export async function listOrphanInflight(db, bootId, staleBefore, limit = 200) {
  return dbClient(db).many(ORPHANS_SQL, bootId, staleBefore, limit)
}

export async function inflightSettled(db, requestId) {
  const row = await dbClient(db).one(SETTLED_SQL, requestId, requestId)
  return { charged: !!row?.charged, logged: !!row?.logged }
}

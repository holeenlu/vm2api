/**
 * 供应商虚拟机开通时读取的运行时账号历史：accounts。db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行。
 */
import { dbClient } from '../../db/db-client.mjs'

/** 已用过的账号 id 与 vm_id，用于新虚拟机避开历史编号。 */
export async function listAccountVmIds(db) {
  return dbClient(db).many('SELECT id,vm_id FROM accounts')
}

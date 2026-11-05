/**
 * 供应商虚拟机开通时读取的运行时账号历史：accounts。db 由调用方注入，返回原始行。
 */

/** 已用过的账号 id 与 vm_id，用于新虚拟机避开历史编号。 */
export function listAccountVmIds(db) {
  return db.prepare('SELECT id,vm_id FROM accounts').all()
}

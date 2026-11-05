/**
 * 执行服务设置仓储（executor_settings、config_revisions）。只做数据访问；校验、缓存与审计内容在 settings-store.mjs。
 */
import { statementCache } from './statement-cache.mjs'

export function latestConfigRevision(db) {
  return statementCache(db)('SELECT MAX(revision) AS r FROM config_revisions').get()?.r
}

export function loadSettingsRow(db, scope) {
  return statementCache(db)('SELECT values_json,revision FROM executor_settings WHERE scope=?').get(scope)
}

/** 新增一版设置版本，返回版本号（RETURNING 不可用时为 undefined） */
export function insertConfigRevision(db, { scope, keysJson, actor, createdAt }) {
  return statementCache(db)(
    'INSERT INTO config_revisions(scope,keys_json,actor,created_at) VALUES(?,?,?,?) RETURNING revision',
  ).get(scope, keysJson, actor, createdAt)?.revision
}

export function upsertSettings(db, { scope, valuesJson, revision, updatedAt, updatedBy }) {
  statementCache(db)(
    `INSERT INTO executor_settings(scope,values_json,revision,updated_at,updated_by) VALUES(?,?,?,?,?)
       ON CONFLICT(scope) DO UPDATE SET values_json=excluded.values_json,revision=excluded.revision,
         updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
  ).run(scope, valuesJson, revision, updatedAt, updatedBy)
}

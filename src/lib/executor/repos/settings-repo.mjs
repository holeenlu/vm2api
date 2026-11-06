/**
 * 执行服务设置仓储（executor_settings、config_revisions）。只做数据访问；校验、缓存与审计内容在 settings-store.mjs。
 * 经 DbClient 异步访问（R6 B3）。
 */
import { dbClient } from '../../db/db-client.mjs'

const LATEST_REVISION_SQL = 'SELECT MAX(revision) AS r FROM config_revisions'
const SETTINGS_ROW_SQL = 'SELECT values_json,revision FROM executor_settings WHERE scope=?'

export async function latestConfigRevision(db) {
  return (await dbClient(db).one(LATEST_REVISION_SQL))?.r
}

export async function loadSettingsRow(db, scope) {
  return dbClient(db).one(SETTINGS_ROW_SQL, scope)
}

/** 新增一版设置版本，返回版本号（RETURNING 不可用时为 undefined） */
export async function insertConfigRevision(db, { scope, keysJson, actor, createdAt }) {
  return (
    await dbClient(db).one(
      'INSERT INTO config_revisions(scope,keys_json,actor,created_at) VALUES(?,?,?,?) RETURNING revision',
      scope,
      keysJson,
      actor,
      createdAt,
    )
  )?.revision
}

export async function upsertSettings(db, { scope, valuesJson, revision, updatedAt, updatedBy }) {
  await dbClient(db).run(
    `INSERT INTO executor_settings(scope,values_json,revision,updated_at,updated_by) VALUES(?,?,?,?,?)
       ON CONFLICT(scope) DO UPDATE SET values_json=excluded.values_json,revision=excluded.revision,
         updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    scope,
    valuesJson,
    revision,
    updatedAt,
    updatedBy,
  )
}

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  currentSettingsRevision,
  importCodexSettingsFromRouting,
  migrateRoutingFile,
  readCodexSettings,
  saveCodexSettings,
} from '../../src/lib/executor/settings-store.mjs'
import {
  DEFAULT_CODEX_SETTINGS,
  normalizeCodexResetCredit,
  normalizeCodexWarmup,
} from '../../src/lib/executor/codex-settings.mjs'
import { warnSchemaMismatch } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import {
  CODEX_ACCOUNT_SCHEMA,
  CODEX_SETTINGS_SCHEMA,
  validateAgainstSchema,
} from '../../src/lib/executor/settings-schema.mjs'

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-settings-'))
  const db = createDatabase({ dataDir: dir })
  try {
    return fn(db)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('routing.json local keys are imported once and stripped; upstream keys stay (P4.2)', () =>
  withDb((db) => {
    const routing = {
      codex: {
        enabled: true,
        user_agent: 'ua',
        warmup: { enabled: true, times: ['08:00'], model: 'gpt-x' },
        bps_enabled: false,
        scheduling: { strategy: 'round_robin' },
      },
      other: 1,
    }
    const imported = importCodexSettingsFromRouting(db, routing)
    assert.equal(imported.changed, true)
    assert.deepEqual(imported.routing, { codex: { enabled: true, user_agent: 'ua' }, other: 1 })
    const settings = readCodexSettings(db)
    assert.equal(settings.values.bps_enabled, false)
    assert.deepEqual(settings.values.warmup, { enabled: true, times: ['08:00'], model: 'gpt-x' })
    assert.equal(settings.values.scheduling.strategy, 'round_robin')
    assert.equal(settings.revision, 1)
    // 再次导入不覆盖已保存的设置
    const again = importCodexSettingsFromRouting(db, { codex: { bps_enabled: true } })
    assert.equal(again.changed, true)
    assert.equal(readCodexSettings(db).values.bps_enabled, false)
    assert.equal(currentSettingsRevision(db), 1)
  }))

test('saves are validated against the schema, merge partially and bump the config revision only on change', () =>
  withDb((db) => {
    assert.deepEqual(readCodexSettings(db).values, DEFAULT_CODEX_SETTINGS)
    assert.equal(readCodexSettings(db).revision, 0)
    const saved = saveCodexSettings(db, { scheduling: { smart_weights: { quota: 2 } }, credit_overage: true }, 'admin')
    assert.deepEqual(saved.changed.sort(), ['credit_overage', 'scheduling'])
    assert.equal(saved.values.scheduling.smart_weights.quota, 2)
    assert.equal(saved.values.scheduling.smart_weights.load, 1, 'other weights are kept')
    assert.equal(saved.revision, 1)
    assert.equal(saveCodexSettings(db, { credit_overage: true }, 'admin').revision, 1, 'no change, no new revision')
    assert.equal(saveCodexSettings(db, { bps_images: { max_images: 30 } }, 'admin').revision, 2)
    for (const [patch, field] of [
      [{ unknown_key: 1 }, 'unknown_key'],
      [{ bps_enabled: 'yes' }, 'bps_enabled'],
      [{ bps_images: { max_images: 0 } }, 'bps_images.max_images'],
      [{ bps_images: { warning_remaining: 40 } }, 'bps_images.warning_remaining'],
      [{ warmup: { times: ['25:00'] } }, 'warmup.times'],
      [{ scheduling: { strategy: 'random' } }, 'scheduling.strategy'],
      [{ bps_defaults: { auto_disable_on_403: false, auto_recover_on_403: true } }, 'bps_defaults.auto_recover_on_403'],
    ])
      assert.throws(
        () => saveCodexSettings(db, patch, 'admin'),
        (error) => error.code === 'invalid_executor_settings' && error.errors.some((item) => item.field === field),
        JSON.stringify(patch),
      )
    assert.throws(() =>
      saveCodexSettings(
        db,
        { scheduling: { smart_weights: { load: 0, quota: 0, health: 0, latency: 0, reset: 0 } } },
        'admin',
      ),
    )
    assert.equal(currentSettingsRevision(db), 2)
    const audit = db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='executor.settings.updated'").get()
    assert.equal(audit.n, 2)
  }))

test('schema defaults match the normalizers and the BPS account schema covers the account settings', () => {
  const defaults = {}
  for (const field of CODEX_SETTINGS_SCHEMA.fields) {
    const parts = field.key.split('.')
    let node = defaults
    for (const part of parts.slice(0, -1)) node = node[part] ||= {}
    node[parts.at(-1)] = field.default
  }
  for (const field of CODEX_SETTINGS_SCHEMA.fields) {
    const expected = field.key.split('.').reduce((node, key) => node?.[key], DEFAULT_CODEX_SETTINGS)
    assert.deepEqual(field.default, expected, field.key)
  }
  assert.deepEqual(validateAgainstSchema(CODEX_SETTINGS_SCHEMA, defaults, defaults), [])
  assert.deepEqual(CODEX_ACCOUNT_SCHEMA.fields.map((field) => field.key).sort(), [
    'auto_disable_on_403',
    'auto_move_on_403',
    'auto_recover_on_403',
    'cache_creation_as_input',
    'enabled',
    'ignore_encrypted_content',
    'models',
    'omit_unsupported_tools',
    'recovery_interval_minutes',
    'target_group_id',
  ])
})

test('local normalizers keep their bounds; routing.json is rewritten without local keys (P4.2)', () =>
  withDb((db) => {
    assert.deepEqual(normalizeCodexResetCredit({ lead_minutes: 30, max_weekly_remaining_percent: 20 }), {
      lead_minutes: 30,
      max_weekly_remaining_percent: 20,
    })
    assert.deepEqual(normalizeCodexResetCredit({ lead_minutes: 0, max_weekly_remaining_percent: 101 }), {
      lead_minutes: 10,
      max_weekly_remaining_percent: null,
    })
    assert.deepEqual(normalizeCodexWarmup({ enabled: true, times: ['25:00'], model: 'x' }).enabled, false)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-file-'))
    const file = path.join(dir, 'routing.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ codex: { enabled: true, credit_overage: true, scheduling: { affinity: 'strict' } } }),
    )
    try {
      const migrated = migrateRoutingFile(db, file)
      assert.equal(migrated.changed, true)
      assert.ok(fs.existsSync(migrated.backup), 'the original routing.json is backed up')
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codex: { enabled: true } })
      const settings = readCodexSettings(db).values
      assert.equal(settings.credit_overage, true)
      assert.equal(settings.scheduling.affinity, 'strict')
      assert.equal(settings.scheduling.smart_weights.load, 1)
      assert.deepEqual(migrateRoutingFile(db, file), { changed: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

test('a Worker reporting another settings schema version is warned about once', () => {
  const lines = []
  const log = { warn: (line) => lines.push(line) }
  assert.equal(
    warnSchemaMismatch(
      'gw-x',
      { settings_schema: { version: CODEX_SETTINGS_SCHEMA.version }, account_schema: { version: 1 } },
      log,
    ),
    false,
  )
  assert.equal(
    warnSchemaMismatch('gw-x', { settings_schema: { version: 99 }, account_schema: { version: 1 } }, log),
    true,
  )
  warnSchemaMismatch('gw-x', { settings_schema: { version: 99 }, account_schema: { version: 1 } }, log)
  assert.equal(lines.length, 1)
  assert.equal(warnSchemaMismatch('gw-x', {}, log), false, 'old Workers without schemas are not warned about')
})

test('hidden dependent fields follow their controlling field instead of blocking the save (R4 P1-1)', () =>
  withDb((db) => {
    saveCodexSettings(
      db,
      { bps_defaults: { auto_recover_on_403: true }, bps_images: { policy: 'warn', warning_remaining: 8 } },
      'test',
    )
    // 关闭 403 自动停用：被隐藏的“自动恢复”随之关闭
    let saved = saveCodexSettings(db, { bps_defaults: { auto_disable_on_403: false } }, 'test')
    assert.equal(saved.values.bps_defaults.auto_recover_on_403, false)
    // 策略为 auto_compact 时改小张数上限：被隐藏的提醒余量收敛到上限以内
    saveCodexSettings(db, { bps_images: { policy: 'auto_compact' } }, 'test')
    saved = saveCodexSettings(db, { bps_images: { max_images: 5 } }, 'test')
    assert.equal(saved.values.bps_images.warning_remaining, 4)
    // 合并语义：部分补丁只改给出的键（R4 P2-2）
    saveCodexSettings(db, { bps_defaults: { auto_disable_on_403: true, auto_recover_on_403: true } }, 'test')
    saved = saveCodexSettings(db, { bps_defaults: { models: ['gpt-5.5'] } }, 'test')
    assert.equal(saved.values.bps_defaults.auto_recover_on_403, true)
    // 乐观锁（R4 P2-3）
    assert.throws(() => saveCodexSettings(db, { credit_overage: true }, 'test', { expectedRevision: 1 }), {
      code: 'settings_revision_conflict',
    })
    // 审计带改动前的值（R4 P2-11）
    const audit = db
      .prepare(
        "SELECT before_json FROM operation_audit WHERE action='executor.settings.updated' ORDER BY rowid DESC LIMIT 1",
      )
      .get()
    assert.deepEqual(JSON.parse(audit.before_json).bps_defaults.models, [])
  }))

test('boot import runs before routing.json is rewritten, so operator settings survive the upgrade (R4 P0-1)', () =>
  withDb((db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-boot-'))
    const file = path.join(dir, 'routing.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        codex: { enabled: true, credit_overage: true, bps_enabled: false, scheduling: { strategy: 'round_robin' } },
      }),
    )
    try {
      // 启动顺序：先导入，再由上游加载与规范化（会去掉本地键）并写回文件
      migrateRoutingFile(db, file)
      const upstreamRewrite = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.writeFileSync(file, JSON.stringify(upstreamRewrite))
      const settings = readCodexSettings(db).values
      assert.deepEqual(
        [settings.credit_overage, settings.bps_enabled, settings.scheduling.strategy],
        [true, false, 'round_robin'],
      )
      // 数据库已有设置时，旧备份里的本地键被忽略（并告警），文件仍被清理
      fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: false } }))
      assert.equal(migrateRoutingFile(db, file).changed, true)
      assert.equal(readCodexSettings(db).values.credit_overage, true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

test('a read failure keeps the last good settings instead of caching defaults (R4 P1-3)', () =>
  withDb((db) => {
    saveCodexSettings(db, { bps_enabled: false }, 'test')
    assert.equal(readCodexSettings(db).values.bps_enabled, false)
    db.exec("UPDATE executor_settings SET values_json='{broken'")
    db.exec("INSERT INTO config_revisions(scope,keys_json,actor,created_at) VALUES('codex','[]','x','x')")
    const original = Date.now
    Date.now = () => original() + 5000
    try {
      assert.equal(readCodexSettings(db).values.bps_enabled, false)
    } finally {
      Date.now = original
    }
  }))

test('saving is refused while the settings cannot be read; a failed boot import keeps a backup (R4 re-review 4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-unreadable-'))
  const first = createDatabase({ dataDir: dir })
  saveCodexSettings(first, { bps_enabled: false }, 'test')
  first.exec("UPDATE executor_settings SET values_json='{broken'")
  first.close()
  // 新进程（没有上一份有效值）读取失败：不能以默认值为基础保存
  const db = createDatabase({ dataDir: dir })
  try {
    assert.throws(() => saveCodexSettings(db, { credit_overage: true }, 'test'), { code: 'settings_unavailable' })
    // 导入失败（数据库出错）时原文件已有备份
    const file = path.join(dir, 'routing.json')
    fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: true } }))
    db.exec('DROP TABLE executor_settings')
    const result = migrateRoutingFile(db, file)
    assert.equal(result.changed, false)
    assert.ok(result.error)
    assert.ok(fs.existsSync(result.backup), 'the original routing.json is backed up before importing')
    assert.equal(JSON.parse(fs.readFileSync(result.backup, 'utf8')).codex.credit_overage, true)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

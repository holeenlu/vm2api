import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDatabase } from '../../src/lib/db/database.mjs'
import {
  currentSettingsRevision,
  importCodexSettingsFromRouting,
  migrateRoutingFile,
  readCodexSettings,
  saveCodexSettings,
  warmCodexSettings,
} from '../../src/lib/executor/settings-store.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
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

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-settings-'))
  const db = createDatabase({ dataDir: dir })
  try {
    return await fn(db)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('routing.json local keys are imported once and stripped; upstream keys stay (P4.2)', () =>
  withDb(async (db) => {
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
    const imported = await importCodexSettingsFromRouting(db, routing)
    assert.equal(imported.changed, true)
    assert.deepEqual(imported.routing, { codex: { enabled: true, user_agent: 'ua' }, other: 1 })
    const settings = readCodexSettings(db)
    assert.equal(settings.values.bps_enabled, false)
    assert.deepEqual(settings.values.warmup, { enabled: true, times: ['08:00'], model: 'gpt-x' })
    assert.equal(settings.values.scheduling.strategy, 'round_robin')
    assert.equal(settings.revision, 1)
    // 再次导入不覆盖已保存的设置
    const again = await importCodexSettingsFromRouting(db, { codex: { bps_enabled: true } })
    assert.equal(again.changed, true)
    assert.equal(readCodexSettings(db).values.bps_enabled, false)
    assert.equal(await currentSettingsRevision(db), 1)
  }))

test('saves are validated against the schema, merge partially and bump the config revision only on change', () =>
  withDb(async (db) => {
    assert.deepEqual(readCodexSettings(db).values, DEFAULT_CODEX_SETTINGS)
    assert.equal(readCodexSettings(db).revision, 0)
    const saved = await saveCodexSettings(
      db,
      { scheduling: { smart_weights: { quota: 2 } }, credit_overage: true },
      'admin',
    )
    assert.deepEqual(saved.changed.sort(), ['credit_overage', 'scheduling'])
    assert.equal(saved.values.scheduling.smart_weights.quota, 2)
    assert.equal(saved.values.scheduling.smart_weights.load, 1, 'other weights are kept')
    assert.equal(saved.revision, 1)
    assert.equal(
      (await saveCodexSettings(db, { credit_overage: true }, 'admin')).revision,
      1,
      'no change, no new revision',
    )
    assert.equal((await saveCodexSettings(db, { bps_images: { max_images: 30 } }, 'admin')).revision, 2)
    // 自动恢复默认开启；先关掉，下面“直接设置的矛盾值”才不会被联动规则当作未编辑的依赖项收敛
    assert.equal((await saveCodexSettings(db, { bps_defaults: { auto_recover_on_403: false } }, 'admin')).revision, 3)
    for (const [patch, field] of [
      [{ unknown_key: 1 }, 'unknown_key'],
      [{ bps_enabled: 'yes' }, 'bps_enabled'],
      [{ bps_images: { max_images: 0 } }, 'bps_images.max_images'],
      [{ bps_images: { warning_remaining: 40 } }, 'bps_images.warning_remaining'],
      [{ warmup: { times: ['25:00'] } }, 'warmup.times'],
      [{ scheduling: { strategy: 'random' } }, 'scheduling.strategy'],
      [{ bps_defaults: { auto_disable_on_403: false, auto_recover_on_403: true } }, 'bps_defaults.auto_recover_on_403'],
    ])
      await assert.rejects(
        () => saveCodexSettings(db, patch, 'admin'),
        (error) => error.code === 'invalid_executor_settings' && error.errors.some((item) => item.field === field),
        JSON.stringify(patch),
      )
    await assert.rejects(() =>
      saveCodexSettings(
        db,
        { scheduling: { smart_weights: { load: 0, quota: 0, health: 0, latency: 0, reset: 0 } } },
        'admin',
      ),
    )
    assert.equal(await currentSettingsRevision(db), 3)
    const audit = db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='executor.settings.updated'").get()
    assert.equal(audit.n, 3)
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
    'rate_limit_cooldown_seconds',
    'recovery_interval_minutes',
    'target_group_id',
  ])
})

test('local normalizers keep their bounds; routing.json is rewritten without local keys (P4.2)', () =>
  withDb(async (db) => {
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
      const migrated = await migrateRoutingFile(db, file)
      assert.equal(migrated.changed, true)
      assert.ok(fs.existsSync(migrated.backup), 'the original routing.json is backed up')
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codex: { enabled: true } })
      const settings = readCodexSettings(db).values
      assert.equal(settings.credit_overage, true)
      assert.equal(settings.scheduling.affinity, 'strict')
      assert.equal(settings.scheduling.smart_weights.load, 1)
      assert.deepEqual(await migrateRoutingFile(db, file), { changed: false })
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
  withDb(async (db) => {
    await saveCodexSettings(
      db,
      { bps_defaults: { auto_recover_on_403: true }, bps_images: { policy: 'warn', warning_remaining: 8 } },
      'test',
    )
    // 关闭 403 自动停用：被隐藏的“自动恢复”随之关闭
    let saved = await saveCodexSettings(db, { bps_defaults: { auto_disable_on_403: false } }, 'test')
    assert.equal(saved.values.bps_defaults.auto_recover_on_403, false)
    // 策略为 auto_compact 时改小张数上限：被隐藏的提醒余量收敛到上限以内
    await saveCodexSettings(db, { bps_images: { policy: 'auto_compact' } }, 'test')
    saved = await saveCodexSettings(db, { bps_images: { max_images: 5 } }, 'test')
    assert.equal(saved.values.bps_images.warning_remaining, 4)
    // 合并语义：部分补丁只改给出的键（R4 P2-2）
    await saveCodexSettings(db, { bps_defaults: { auto_disable_on_403: true, auto_recover_on_403: true } }, 'test')
    saved = await saveCodexSettings(db, { bps_defaults: { models: ['gpt-5.5'] } }, 'test')
    assert.equal(saved.values.bps_defaults.auto_recover_on_403, true)
    // 乐观锁（R4 P2-3）
    await assert.rejects(() => saveCodexSettings(db, { credit_overage: true }, 'test', { expectedRevision: 1 }), {
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
  withDb(async (db) => {
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
      await migrateRoutingFile(db, file)
      const upstreamRewrite = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.writeFileSync(file, JSON.stringify(upstreamRewrite))
      const settings = readCodexSettings(db).values
      assert.deepEqual(
        [settings.credit_overage, settings.bps_enabled, settings.scheduling.strategy],
        [true, false, 'round_robin'],
      )
      // 数据库已有设置、文件里的值回到默认值：与旧版本对着已删键的文件补默认值无法区分，保守不导入（复核 J1），文件仍被清理
      fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: false } }))
      assert.equal((await migrateRoutingFile(db, file)).changed, true)
      assert.equal(readCodexSettings(db).values.credit_overage, true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

// 最终审计 U1：升级 → 新版本修改 → 回滚（恢复备份）并在旧版本修改 → 再升级。
// 回滚期间改的键导入；只在新版本改过的键保留；没有备份基线时维持忽略；非法的键单独跳过
test('settings changed while an older version ran are merged back on the next upgrade', () =>
  withDb(async (db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rollback-'))
    const file = path.join(dir, 'routing.json')
    const write = (codex) => fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true, ...codex } }))
    try {
      write({ bps_enabled: true, credit_overage: false, warmup: { enabled: false, times: [], model: 'gpt-x' } })
      await migrateRoutingFile(db, file)
      const [firstBackup] = fs.readdirSync(dir).filter((name) => name.includes('.bak-'))
      // 新版本里改了预热
      await saveCodexSettings(db, { warmup: { enabled: true, times: ['08:00'], model: 'gpt-x' } }, 'operator')
      // 回滚：恢复备份，旧版本里关掉 BPS（键顺序也被旧版本改写）
      const restored = JSON.parse(fs.readFileSync(path.join(dir, firstBackup), 'utf8'))
      restored.codex.bps_enabled = false
      restored.codex.warmup = { model: 'gpt-x', times: [], enabled: false }
      fs.writeFileSync(file, JSON.stringify(restored))
      await new Promise((resolve) => setTimeout(resolve, 5))
      const result = await migrateRoutingFile(db, file)
      assert.deepEqual(result.imported, ['bps_enabled'])
      const values = readCodexSettings(db).values
      assert.equal(values.bps_enabled, false, 'the change made while rolled back is imported')
      assert.deepEqual(values.warmup.times, ['08:00'], 'a key unchanged since the last import keeps the database value')
      assert.equal(values.credit_overage, false)
      const audit = db
        .prepare("SELECT actor FROM operation_audit WHERE action='executor.settings.updated' ORDER BY id DESC LIMIT 1")
        .get()
      assert.equal(audit.actor, 'migration:routing.json-rollback')
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codex.bps_enabled, undefined, 'the file is stripped again')

      // 非法的键单独跳过，合法的照常导入
      write({ bps_enabled: true, credit_overage: true, reset_credit: { enabled: 'not-a-boolean' } })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const partial = await migrateRoutingFile(db, file)
      assert.equal(partial.imported.includes('reset_credit'), false)
      assert.equal(readCodexSettings(db).values.credit_overage, true)

      // 备份被清理后仍以数据库里的合并基线判断；文件回到默认值视为旧版本补齐，不导入
      for (const name of fs.readdirSync(dir)) if (name.includes('.bak-')) fs.rmSync(path.join(dir, name))
      write({ credit_overage: false })
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.equal(readCodexSettings(db).values.credit_overage, true)
      // 合并基线与时间戳备份都没有（本功能之前就已升级、备份又被清理）：无法判断先后，维持忽略
      for (const name of fs.readdirSync(dir)) if (name.includes('.bak-')) fs.rmSync(path.join(dir, name))
      db.prepare("DELETE FROM executor_settings WHERE scope='codex:routing-baseline'").run()
      write({ warmup: { enabled: true, times: ['07:00'], model: 'gpt-x' } })
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.deepEqual(readCodexSettings(db).values.warmup.times, ['08:00'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

// 复核 J1、J2、J3、J4、J5：保守合并的风险路径。旧版本（v1.4.038.14）启动时会把它认识的 6 个本地键补成默认值写回 routing.json
const OLD_VERSION_KEYS = ['gateway_worker', 'scheduling', 'warmup', 'reset_credit', 'credit_overage', 'bps_enabled']
const oldVersionDefaults = () => Object.fromEntries(OLD_VERSION_KEYS.map((key) => [key, DEFAULT_CODEX_SETTINGS[key]]))

test('rollback merges never reset settings to defaults, keep new-version edits and survive failures', () =>
  withDb(async (db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rollback-risk-'))
    const file = path.join(dir, 'routing.json')
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    const values = () => readCodexSettings(db).values
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          codex: {
            credit_overage: true,
            bps_enabled: false,
            scheduling: { strategy: 'round_robin' },
            gateway_worker: { preference: 'gateway_worker' },
          },
        }),
      )
      await migrateRoutingFile(db, file)
      // J1：回滚时没有恢复备份，旧版本对着已删键的文件补默认值；再升级不能把设置重置为默认值
      fs.writeFileSync(file, JSON.stringify({ codex: oldVersionDefaults() }))
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.deepEqual(
        [
          values().credit_overage,
          values().bps_enabled,
          values().scheduling.strategy,
          values().gateway_worker.preference,
        ],
        [true, false, 'round_robin', 'gateway_worker'],
      )
      // J2：新版本改过、文件也改过的键是冲突，保留数据库的值；基线缺的键按默认值比较，旧版本补齐不算改动
      await saveCodexSettings(
        db,
        { credit_overage: false, warmup: { enabled: true, times: ['09:00'], model: 'm' } },
        'op',
      )
      fs.writeFileSync(
        file,
        JSON.stringify({
          codex: {
            ...oldVersionDefaults(),
            credit_overage: true,
            bps_enabled: false,
            scheduling: { strategy: 'round_robin' },
            gateway_worker: { preference: 'gateway_worker' },
          },
        }),
      )
      await tick()
      const conflict = await migrateRoutingFile(db, file)
      assert.deepEqual(conflict.imported, [])
      assert.equal(values().credit_overage, false, 'both sides changed: the database value is kept')
      assert.deepEqual(values().warmup.times, ['09:00'])
      // J3：数据库出错时不清理文件，本次备份改名不作参照；恢复后重试照常导入回滚期间的修改
      const changedWarmup = { enabled: true, times: ['10:00'], model: 'm' }
      fs.writeFileSync(file, JSON.stringify({ codex: { ...oldVersionDefaults(), warmup: changedWarmup } }))
      await tick()
      db.exec('ALTER TABLE config_revisions RENAME TO config_revisions_hidden')
      const failed = await migrateRoutingFile(db, file)
      assert.ok(failed.error)
      assert.match(failed.backup, /\.failed$/)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(file, 'utf8')).codex.warmup,
        changedWarmup,
        'the file is not stripped',
      )
      // 同一次启动里上游加载 routing.json 会把本地键删掉写回（复核 K1）：本地键只剩在 .failed 备份里
      fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true } }))
      db.exec('ALTER TABLE config_revisions_hidden RENAME TO config_revisions')
      await tick()
      const retried = await migrateRoutingFile(db, file)
      assert.deepEqual(retried.imported, ['warmup'], 'the unfinished import is retried from the .failed backup')
      assert.equal(retried.retried, failed.backup)
      assert.ok(fs.existsSync(`${failed.backup}.retried`))
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).codex, { enabled: true }, 'upstream keys are kept')
      // 重试完成后不再重复
      await tick()
      assert.equal((await migrateRoutingFile(db, file)).changed, false)
      assert.deepEqual(values().warmup.times, ['10:00'])
      // J4：手工命名的备份不作参照（否则 11:00 会被当成起点而不导入）
      fs.writeFileSync(
        `${file}.bak-manual`,
        JSON.stringify({ codex: { warmup: { enabled: true, times: ['11:00'], model: 'm' } } }),
      )
      fs.writeFileSync(file, JSON.stringify({ codex: { warmup: { enabled: true, times: ['11:00'], model: 'm' } } }))
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, ['warmup'])
      // J5：从面板备份恢复时不合并
      fs.writeFileSync(file, JSON.stringify({ codex: { warmup: { enabled: true, times: ['12:00'], model: 'm' } } }))
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file, { mergeRollback: false })).imported, [])
      assert.deepEqual(values().warmup.times, ['11:00'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

// 复核 L1、L2、L3：恢复更早的备份不覆盖新版本的修改；面板恢复不重试启动时的失败导入；被取代的失败备份不再重试
test('restoring an earlier backup keeps new-version edits; restores never retry boot failures', () =>
  withDb(async (db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rollback-l1-'))
    const file = path.join(dir, 'routing.json')
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    const strategy = () => readCodexSettings(db).values.scheduling.strategy
    try {
      fs.writeFileSync(file, JSON.stringify({ codex: { scheduling: { strategy: 'round_robin' } } }))
      await migrateRoutingFile(db, file)
      const [first] = fs.readdirSync(dir).filter((name) => name.includes('.bak-'))
      await saveCodexSettings(db, { scheduling: { strategy: 'sticky' } }, 'op')
      // 第二轮回滚没有恢复备份：旧版本补默认值，最新备份里是默认值
      fs.writeFileSync(file, JSON.stringify({ codex: oldVersionDefaults() }))
      await tick()
      await migrateRoutingFile(db, file)
      assert.equal(strategy(), 'sticky')
      // 第三轮按文档改用更早、内容正确的备份，旧版本里什么都不改：新版本的 sticky 不能被改回 round_robin
      fs.copyFileSync(path.join(dir, first), file)
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.equal(strategy(), 'sticky')

      // L2：面板恢复路径出错时备份用 .restore-failed，下一次启动不重试它
      fs.writeFileSync(file, JSON.stringify({ codex: { scheduling: { strategy: 'least_used' } } }))
      db.exec('ALTER TABLE config_revisions RENAME TO config_revisions_hidden')
      await tick()
      const restoreFailed = await migrateRoutingFile(db, file, { mergeRollback: false })
      assert.match(restoreFailed.backup || '', /\.restore-failed$/)
      db.exec('ALTER TABLE config_revisions_hidden RENAME TO config_revisions')
      fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true } }))
      await tick()
      assert.equal((await migrateRoutingFile(db, file)).changed, false)
      assert.equal(strategy(), 'sticky')
      // 启动时的失败导入也不被面板恢复取走（恢复以恢复的数据库为准）
      fs.writeFileSync(file, JSON.stringify({ codex: { warmup: { enabled: true, times: ['06:00'], model: 'm' } } }))
      db.exec('ALTER TABLE config_revisions RENAME TO config_revisions_hidden')
      await tick()
      const bootFailed = await migrateRoutingFile(db, file)
      assert.match(bootFailed.backup, /\.failed$/)
      db.exec('ALTER TABLE config_revisions_hidden RENAME TO config_revisions')
      fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true } }))
      await tick()
      assert.equal((await migrateRoutingFile(db, file, { mergeRollback: false })).changed, false)
      assert.ok(fs.existsSync(bootFailed.backup), 'the boot failure stays for the next boot')
      // L3：之后又有一次正常导入写出更新的有效备份时，旧的失败备份被取代，不再重试
      fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: true } }))
      await tick()
      await migrateRoutingFile(db, file)
      assert.equal(fs.existsSync(bootFailed.backup), false)
      assert.ok(fs.existsSync(bootFailed.backup.replace(/\.failed$/, '.superseded')))
      fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true } }))
      await tick()
      assert.equal((await migrateRoutingFile(db, file)).changed, false)
      // 复核 N2：备份写出后、导入提交前进程被杀（子进程在复制备份后立即 SIGKILL 自己），下一次启动仍导入回滚期间的修改
      fs.writeFileSync(file, JSON.stringify({ codex: { warmup: { enabled: true, times: ['05:00'], model: 'm' } } }))
      await tick()
      const dbFile = db.location()
      const script = `
        import fs from 'node:fs'
        import { DatabaseSync } from 'node:sqlite'
        const { migrateRoutingFile } = await import(${JSON.stringify(new URL('../../src/lib/executor/settings-store.mjs', import.meta.url).href)})
        const write = fs.writeFileSync
        fs.writeFileSync = (...args) => { write(...args); if (String(args[0]).endsWith('.pending')) process.kill(process.pid, 'SIGKILL') }
        await migrateRoutingFile(new DatabaseSync(${JSON.stringify(dbFile)}), ${JSON.stringify(file)})
      `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, ['warmup'], 'the interrupted import is not lost')
      assert.deepEqual(readCodexSettings(db).values.warmup.times, ['05:00'])
      assert.equal(
        fs.readdirSync(dir).some((name) => name.endsWith('.pending')),
        false,
        'the interrupted backup is superseded after the next import',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

// 审计 N1：备份带自身标记，运维复制回去后旧版本保留顶层标记；再次升级按那一份备份判断，
// 两值键（BPS 开关）在多轮回滚后、改回默认值或改回其他备份里的值都能导入；标记失效时回到保守规则
test('backup markers let rollback edits of two-valued settings be imported across cycles', () =>
  withDb(async (db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rollback-n1-'))
    const file = path.join(dir, 'routing.json')
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    const bps = () => readCodexSettings(db).values.bps_enabled
    const latest = () =>
      fs
        .readdirSync(dir)
        .filter((name) => /\.bak-[0-9TZ-]+$/.test(name))
        .sort()
        .at(-1)
    // 旧版本启动：恢复的文件按它的规则改写，顶层未知字段保留
    const oldVersionEdits = (backup, codex) => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, backup), 'utf8'))
      fs.writeFileSync(file, JSON.stringify({ ...doc, codex: { ...doc.codex, ...codex } }))
    }
    try {
      fs.writeFileSync(file, JSON.stringify({ other: 1, codex: { enabled: true, bps_enabled: false } }))
      await migrateRoutingFile(db, file)
      const first = latest()
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8'))._tapmodels_backup,
        first.split('.bak-')[1],
      )
      assert.equal(
        JSON.parse(fs.readFileSync(file, 'utf8'))._tapmodels_backup,
        undefined,
        'routing.json carries no marker',
      )
      // 第一轮回滚：恢复备份，旧版本里打开 BPS
      oldVersionEdits(first, { bps_enabled: true })
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, ['bps_enabled'])
      assert.equal(bps(), true)
      // 第二轮回滚：恢复最近的备份，旧版本里关掉 BPS（与第一份备份的值相同，此前的保守规则会忽略）
      const second = latest()
      oldVersionEdits(second, { bps_enabled: false })
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, ['bps_enabled'])
      assert.equal(bps(), false)
      const written = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(written._tapmodels_backup, undefined)
      assert.equal(written.other, 1, 'upstream keys are kept')
      // 恢复更早的备份、旧版本里什么都不改：与起点相同，不导入（复核 L1 不回退）
      oldVersionEdits(first, {})
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.equal(bps(), false)
      // 标记指向的备份已删除：回到保守规则，改回其他备份里出现过的值不导入
      const third = latest()
      oldVersionEdits(third, { bps_enabled: true })
      fs.rmSync(path.join(dir, third))
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.equal(bps(), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

// 复核 T1、T3：导入出错后标记不残留在 routing.json（否则一次不复制备份的回滚会把旧版本补的默认值当成修改导入）；
// 重试从 .failed 备份里取回起点；标记只认有效的时间戳备份
test('the backup marker never lingers after a failed import and only points at valid backups', () =>
  withDb(async (db) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-rollback-t1-'))
    const file = path.join(dir, 'routing.json')
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    const values = () => readCodexSettings(db).values
    const latest = () =>
      fs
        .readdirSync(dir)
        .filter((name) => /\.bak-[0-9TZ-]+$/.test(name))
        .sort()
        .at(-1)
    try {
      fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: true, bps_enabled: false } }))
      await migrateRoutingFile(db, file)
      const first = latest()
      // 恢复备份后导入出错：文件里的标记仍被去掉，本地键保留
      fs.copyFileSync(path.join(dir, first), file)
      db.exec('ALTER TABLE config_revisions RENAME TO config_revisions_hidden')
      await tick()
      const failed = await migrateRoutingFile(db, file)
      assert.ok(failed.error)
      const left = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(left._tapmodels_backup, undefined, 'the marker does not linger after a failed import')
      assert.equal(left.codex.credit_overage, true)
      assert.equal(
        JSON.parse(fs.readFileSync(failed.backup, 'utf8'))._tapmodels_backup_start,
        first.split('.bak-')[1],
        'the failed backup keeps the start marker for the retry',
      )
      db.exec('ALTER TABLE config_revisions_hidden RENAME TO config_revisions')
      // 复核 U3：重试从 .failed 取回起点。新建一份带起点的备份，恢复它并把 BPS 改回第一份备份里的值；
      // 导入出错、同一次启动上游删掉本地键后，下一次启动重试：按起点判断为修改并导入
      fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: true, bps_enabled: true } }))
      await saveCodexSettings(db, { bps_enabled: true }, 'op')
      await tick()
      await migrateRoutingFile(db, file)
      const second = latest()
      const restored = JSON.parse(fs.readFileSync(path.join(dir, second), 'utf8'))
      fs.writeFileSync(file, JSON.stringify({ ...restored, codex: { ...restored.codex, bps_enabled: false } }))
      db.exec('ALTER TABLE config_revisions RENAME TO config_revisions_hidden')
      await tick()
      const failedAgain = await migrateRoutingFile(db, file)
      assert.ok(failedAgain.error)
      fs.writeFileSync(file, JSON.stringify({ codex: { enabled: true } }))
      db.exec('ALTER TABLE config_revisions_hidden RENAME TO config_revisions')
      await tick()
      const retried = await migrateRoutingFile(db, file)
      assert.equal(retried.retried, failedAgain.backup)
      assert.deepEqual(retried.imported, ['bps_enabled'], 'the retry uses the start backup kept in the failed backup')
      assert.equal(values().bps_enabled, false)
      await saveCodexSettings(db, { bps_enabled: false }, 'op')
      // 之后不复制备份就回滚：旧版本对着去掉本地键的文件补默认值；再次升级不能把设置改成默认值
      fs.writeFileSync(file, JSON.stringify({ codex: oldVersionDefaults() }))
      await tick()
      assert.deepEqual((await migrateRoutingFile(db, file)).imported, [])
      assert.deepEqual([values().credit_overage, values().bps_enabled], [true, false])
      // 标记指向的不是有效时间戳备份（存在的 .superseded 文件、路径穿越、随意字符串）：回到保守规则
      const stamp = failed.backup.split('.bak-')[1].replace(/\.failed$/, '')
      assert.ok(
        fs.existsSync(`${file}.bak-${stamp}.superseded`),
        'the failed backup was superseded by the later import',
      )
      for (const marker of [`${stamp}.superseded`, '../../etc/passwd', 'manual']) {
        fs.writeFileSync(file, JSON.stringify({ _tapmodels_backup: marker, codex: { credit_overage: false } }))
        await tick()
        assert.deepEqual((await migrateRoutingFile(db, file)).imported, [], marker)
        assert.equal(values().credit_overage, true)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }))

test('a read failure keeps the last good settings instead of caching defaults (R4 P1-3)', () =>
  withDb(async (db) => {
    await saveCodexSettings(db, { bps_enabled: false }, 'test')
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

test('saving is refused while the settings cannot be read; a failed boot import keeps a backup (R4 re-review 4)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-unreadable-'))
  const first = createDatabase({ dataDir: dir })
  await saveCodexSettings(first, { bps_enabled: false }, 'test')
  first.exec("UPDATE executor_settings SET values_json='{broken'")
  first.close()
  // 新进程（没有上一份有效值）读取失败：不能以默认值为基础保存
  const db = createDatabase({ dataDir: dir })
  try {
    await assert.rejects(() => saveCodexSettings(db, { credit_overage: true }, 'test'), {
      code: 'settings_unavailable',
    })
    // 导入失败（数据库出错）时原文件已有备份
    const file = path.join(dir, 'routing.json')
    fs.writeFileSync(file, JSON.stringify({ codex: { credit_overage: true } }))
    db.exec('DROP TABLE executor_settings')
    const result = await migrateRoutingFile(db, file)
    assert.equal(result.changed, false)
    assert.ok(result.error)
    assert.ok(fs.existsSync(result.backup), 'the original routing.json is backed up before importing')
    assert.equal(JSON.parse(fs.readFileSync(result.backup, 'utf8')).codex.credit_overage, true)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// R6 B3：请求路径同步读取的是进程内快照。预热后不再查库；过期时先返回现有快照、后台刷新；写入后立即读到新值
test('settings reads are served from the warmed snapshot and refreshed in the background (R6 B3)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-snapshot-'))
  const first = createDatabase({ dataDir: dir })
  await saveCodexSettings(first, { credit_overage: true }, 'test')
  first.close()
  const db = createDatabase({ dataDir: dir })
  const original = Date.now
  try {
    const warmed = await warmCodexSettings(db)
    assert.equal(warmed.values.credit_overage, true)
    // 另一个进程改了设置（直接写库，不经本进程的快照）
    db.exec("INSERT INTO config_revisions(scope,keys_json,actor,created_at) VALUES('codex','[]','other','x')")
    const revision = db.prepare('SELECT MAX(revision) AS r FROM config_revisions').get().r
    db.prepare("UPDATE executor_settings SET values_json=?,revision=? WHERE scope='codex'").run(
      JSON.stringify({ ...warmed.values, credit_overage: false }),
      revision,
    )
    // 统计读取期间的数据库访问：DbClient 的方法（R6 B8 起没有同步方法），以及原生 prepare
    const client = dbClient(db)
    let queries = 0
    const restore = []
    for (const name of ['one', 'many', 'run']) {
      const method = client[name]
      client[name] = (...args) => {
        queries++
        return method.apply(client, args)
      }
      restore.push(() => {
        client[name] = method
      })
    }
    const prepare = db.prepare
    db.prepare = (...args) => {
      queries++
      return prepare.apply(db, args)
    }
    restore.push(() => {
      db.prepare = prepare
    })
    try {
      for (let i = 0; i < 3; i++) assert.equal(readCodexSettings(db).values.credit_overage, true)
      assert.equal(queries, 0, 'a fresh snapshot is served without touching the database')
      // 过期：立即返回现有快照（不在调用栈里查库），随后后台刷新到新值
      Date.now = () => original() + 1500
      assert.equal(readCodexSettings(db).values.credit_overage, true)
      assert.equal(readCodexSettings(db).values.credit_overage, true)
      assert.equal(queries, 0, 'a stale snapshot is returned first; the refresh runs afterwards')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(queries, 2, 'one background refresh reads the revision and the settings row')
      const refreshed = readCodexSettings(db)
      assert.equal(refreshed.values.credit_overage, false)
      assert.equal(refreshed.revision, revision)
      assert.equal(queries, 2)
    } finally {
      Date.now = original
      for (const undo of restore) undo()
    }
    // 写入后立即读到新值（不等刷新）
    const saved = await saveCodexSettings(db, { bps_enabled: false }, 'test')
    const after = readCodexSettings(db)
    assert.equal(after.values.bps_enabled, false)
    assert.equal(after.values.credit_overage, false)
    assert.equal(after.revision, saved.revision)
  } finally {
    Date.now = original
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

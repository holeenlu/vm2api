/**
 * 时间戳按 UTC+8 存储（用户决定 2026-11-07）：dbTime 的格式与边界、db-client 绑定改写、
 * 以及“不得新增 UTC-Z 写入”的守卫。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dbTime, dbTimeParam } from '../../src/shared/system-time.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

test('dbTime 产出固定偏移、固定宽度的存储形式，绝对时刻不变', () => {
  assert.equal(dbTime('2026-11-07T12:43:20.316Z'), '2026-11-07T20:43:20.316+08:00')
  assert.equal(dbTime(Date.parse('2026-11-07T12:43:20.316Z')), '2026-11-07T20:43:20.316+08:00')
  assert.equal(dbTime(new Date('2026-11-07T12:43:20.316Z')), '2026-11-07T20:43:20.316+08:00')
  // 无毫秒、单位小数都补到至少三位；Go 的 RFC3339Nano 保留原有位数
  assert.equal(dbTime('2026-11-07T12:43:20Z'), '2026-11-07T20:43:20.000+08:00')
  assert.equal(dbTime('2026-11-07T12:43:20.1Z'), '2026-11-07T20:43:20.100+08:00')
  assert.equal(dbTime('2026-11-07T12:43:20.123456789Z'), '2026-11-07T20:43:20.123456789+08:00')
  // 已带偏移的值按同一时刻重新表示
  assert.equal(dbTime('2026-11-07T20:43:20.316+08:00'), '2026-11-07T20:43:20.316+08:00')
  assert.equal(dbTime('2026-11-07T07:43:20.316-05:00'), '2026-11-07T20:43:20.316+08:00')
  // 跨零点：UTC 当天 16:00 之后属于 UTC+8 的次日
  assert.equal(dbTime('2026-11-07T16:00:00.000Z'), '2026-11-08T00:00:00.000+08:00')
  assert.equal(dbTime('2026-12-31T16:00:00.000Z'), '2027-01-01T00:00:00.000+08:00')
  assert.throws(() => dbTime('not a time'), RangeError)
})

test('字符串序等于时间序，跨小数位数也成立', () => {
  const stamps = [
    '2026-11-07T12:43:20Z',
    '2026-11-07T12:43:20.1Z',
    '2026-11-07T12:43:20.100000001Z',
    '2026-11-07T12:43:20.316Z',
    '2026-11-07T12:43:21Z',
  ].map(dbTime)
  assert.deepEqual([...stamps].sort(), stamps)
})

test('dbTimeParam 只改写整串 ISO-Z，其他值原样传递', () => {
  assert.equal(dbTimeParam('2026-11-07T12:43:20.316Z'), '2026-11-07T20:43:20.316+08:00')
  for (const value of ['hello Z', '2026-11-07', 'Z', '', 5, null, undefined, true]) {
    assert.equal(dbTimeParam(value), value)
  }
  // 已是存储形式的值不再改写
  assert.equal(dbTimeParam('2026-11-07T20:43:20.316+08:00'), '2026-11-07T20:43:20.316+08:00')
})

test('db-client 在绑定时把 ISO-Z 参数改写成存储形式', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT, note TEXT)')
  const client = dbClient(db)
  await client.run('INSERT INTO t(id, at, note) VALUES(?, ?, ?)', 1, '2026-11-07T12:43:20.316Z', 'keep Z here')
  const row = await client.one('SELECT at, note FROM t WHERE id = ?', 1)
  assert.equal(row.at, '2026-11-07T20:43:20.316+08:00')
  assert.equal(row.note, 'keep Z here')
  // 范围查询的参数同样改写，边界可比
  const hit = await client.many('SELECT id FROM t WHERE at >= ?', '2026-11-07T12:43:20.316Z')
  assert.equal(hit.length, 1)
  const miss = await client.many('SELECT id FROM t WHERE at > ?', '2026-11-07T12:43:20.316Z')
  assert.equal(miss.length, 0)
  db.close()
})

test('命名参数对象里的时间戳也会改写', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT)')
  const client = dbClient(db)
  await client.run('INSERT INTO t(id, at) VALUES($id, $at)', { id: 1, at: '2026-11-07T12:43:20.316Z' })
  assert.equal((await client.one('SELECT at FROM t'))?.at, '2026-11-07T20:43:20.316+08:00')
  db.close()
})

const sources = []
for (const dir of ['src', 'scripts']) {
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(mjs|sql)$/.test(entry.name)) sources.push(full)
    }
  }
  walk(path.join(root, dir))
}

test('守卫：不再新增写入 UTC-Z 的 SQL（已应用的历史迁移除外）', () => {
  const migrations = path.join(root, 'src/lib/db/migrations')
  const offenders = sources.filter(
    (f) => !f.startsWith(migrations) && /strftime\('%Y-%m-%dT%H:%M:%(f|S)Z'/.test(fs.readFileSync(f, 'utf8')),
  )
  assert.deepEqual(offenders, [], '时间戳写入请用 UTC+8 存储形式（dbTime 或 strftime(...,"+8 hours") || "+08:00"）')
})

test('守卫：时间列不按字符位置截取（偏移改变会错位），改用 strftime', () => {
  // 历史迁移是已应用的事实，不改写；最终 schema 由下一个用例按 sqlite_master 核验
  const migrations = path.join(root, 'src/lib/db/migrations')
  const offenders = sources.filter(
    (f) =>
      !f.startsWith(migrations) &&
      /substr\(\s*(?:NEW\.|OLD\.|[a-z]+\.)?(?:created_at|occurred_at|received_at|started_at|updated_at)\s*,/.test(
        fs.readFileSync(f, 'utf8'),
      ),
  )
  assert.deepEqual(offenders, [], '时间列请用 strftime 取桶键，substr 会随偏移错位')
})

test('守卫：最新迁移重建后的触发器不再写 UTC-Z，也不再 substr 时间列', async () => {
  const { createDatabase } = await import('../../src/lib/db/database.mjs')
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'db-time-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  const bad = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND (sql LIKE '%fZ%' OR sql LIKE '%substr(%created_at%')",
    )
    .all()
  assert.deepEqual(bad, [])
  // 小时汇总键保持 UTC：写入一条 UTC+8 存储形式的用量后，桶键应是 UTC 小时
  db.exec("INSERT INTO usage_logs(id, created_at, status) VALUES('u1', '2026-11-08T00:30:00.000+08:00', 200)")
  const hour = db.prepare('SELECT hour FROM usage_stats_hourly LIMIT 1').get()
  assert.equal(hour?.hour, '2026-11-07T16')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

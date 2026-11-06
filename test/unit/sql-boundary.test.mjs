import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compare, countSqlSites, isRepositoryPath, loadBaseline, scan } from '../../scripts/sql-boundary.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('SQL outside repositories matches the baseline exactly', () => {
  const problems = compare(scan(ROOT), loadBaseline(ROOT))
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('the baseline only holds exemptions with a reason', () => {
  for (const [file, entry] of Object.entries(loadBaseline(ROOT))) {
    assert.ok(entry.count > 0, `${file}: count must be positive (delete the entry when it reaches 0)`)
    assert.equal(
      entry.kind,
      'exempt',
      `${file}: SQL outside repositories must move into a repository, not into the baseline`,
    )
    assert.ok(entry.reason, `${file}: an exemption needs a reason`)
  }
})

test('counts SQL prepares and database execs, not other prepare APIs', () => {
  const source = [
    "db.prepare('SELECT 1').get()",
    'getDb()\n  .prepare(\n    `SELECT * FROM t`,\n  )',
    'this.db.prepare(sql)',
    'cache.prepare({ scope })',
    "db.exec('BEGIN')",
    "getDb().exec('COMMIT')",
    'regex.exec(text)',
  ].join('\n')
  assert.equal(countSqlSites(source), 5)
})

test('repository locations', () => {
  assert.equal(isRepositoryPath('src/lib/db/database.mjs'), true)
  assert.equal(isRepositoryPath('src/lib/vendor/repos/resources-repo.mjs'), true)
  assert.equal(isRepositoryPath('src/lib/gateway-worker/gateway-repo.mjs'), true)
  assert.equal(isRepositoryPath('src/lib/vendor/vendor-platform.mjs'), false)
})

test('compare flags growth, shrinkage and unknown files', () => {
  const baseline = { 'a.mjs': { count: 2, kind: 'pending' }, 'b.mjs': { count: 1, kind: 'pending' } }
  assert.deepEqual(compare({ 'a.mjs': 2, 'b.mjs': 1 }, baseline), [])
  const problems = compare({ 'a.mjs': 3, 'c.mjs': 1 }, baseline)
  assert.equal(problems.length, 3)
  assert.match(problems[0], /^a\.mjs: 3/)
  assert.match(problems[1], /^b\.mjs: 已减少到 0/)
  assert.match(problems[2], /^c\.mjs: 1/)
})

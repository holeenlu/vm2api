import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'

test('admin scope is grouped by the super-admin root', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-user-scope-'))
  try {
    openDatabase({ dataDir })
    const db = getDb()
    const users = new UsersRepo(db)
    const rows = [
      ['sa', 'super_admin', null],
      ['a', 'admin', 'sa'],
      ['a1', 'admin', 'a'],
      ['a2', 'admin', 'a'],
      ['a3', 'admin', 'a1'],
      ['au', 'user', 'a2'],
      ['b', 'admin', 'sa'],
      ['b1', 'admin', 'b'],
      ['bu', 'user', 'b1'],
    ]
    for (const [id, role, parent_user_id] of rows)
      users.insert({ id, username: id, role, parent_user_id, password_hash: 'unused' })

    assert.equal(users.scopeRootId('a3'), 'a')
    assert.deepEqual(users.scopeIds('a').sort(), ['a', 'a1', 'a2', 'a3', 'au'])
    assert.deepEqual(users.scopeIds('a3').sort(), ['a', 'a1', 'a2', 'a3', 'au'])
    assert.deepEqual(users.scopeIds('b').sort(), ['b', 'b1', 'bu'])
    assert.equal(users.isInScope('b1', 'a'), false)
    assert.equal(users.isInScope('a3', 'b'), false)
  } finally {
    closeDatabase()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

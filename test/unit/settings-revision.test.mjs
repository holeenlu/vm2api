import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

test('settings repo advances runtime config revision with compare-and-swap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-settings-revision-'))
  try {
    const db = createDatabase({ dbPath: path.join(root, 'kin.db') })
    const settings = new SettingsRepo(db)
    assert.equal(settings.getConfigRevision(), 1)
    assert.equal(settings.advanceConfigRevision(0), null)
    assert.equal(settings.advanceConfigRevision(1), 2)
    assert.equal(settings.getConfigRevision(), 2)
    assert.equal(settings.advanceConfigRevision(1), null)
    assert.equal(settings.advanceConfigRevision(2), 3)
    db.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

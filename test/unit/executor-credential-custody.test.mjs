import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createCredentialVault, loadKeyring } from '../../src/lib/executor/vault.mjs'
import { createCredentialCustody } from '../../src/lib/executor/credential-custody.mjs'

// 凭据托管（S1/S1b 之后）：授权、导入由控制面直接写凭据库，刷新由 Worker 按代次写回；托管层只剩导出、删除与读代次
async function withCustody(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'))
  const db = createDatabase({ dataDir: dir })
  const vault = createCredentialVault({ db, keyring: loadKeyring({ file: path.join(dir, 'keys.json') }) })
  const custody = createCredentialCustody({ db, vault })
  try {
    return await fn({ db, vault, custody })
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('account export reads only the vault; forgetting a grant removes its record', () =>
  withCustody(async ({ vault, custody }) => {
    await vault.put({
      accountResourceId: 'acct_1',
      grant: 'native',
      revision: 3,
      secrets: { access_token: 'at3', refresh_token: 'rt3' },
      expiresAt: '2030-01-01T00:00:00.000Z',
      source: 't',
    })
    const out = await custody.exportSecrets({
      accountResourceId: 'acct_1',
      account: { email: 'a@example.test', chatgpt_account_id: '' },
    })
    assert.deepEqual(out.credentials, {
      access_token: 'at3',
      refresh_token: 'rt3',
      id_token: '',
      chatgpt_account_id: '',
      email: 'a@example.test',
      expires_at: Date.parse('2030-01-01T00:00:00.000Z') / 1000,
    })
    assert.equal(await custody.vaultRevision('acct_1', 'native'), 3)
    assert.equal(await custody.forget('acct_1'), 1)
    assert.equal(await vault.get('acct_1', 'native'), null)
  }))

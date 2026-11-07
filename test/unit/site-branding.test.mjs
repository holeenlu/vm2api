import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { DEFAULT_BRANDING, siteBranding, saveSiteBranding } from '../../src/lib/admin/site-branding.mjs'
test('branding is persisted, validates assets, and does not expose unrelated settings', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  assert.equal(DEFAULT_BRANDING.name, 'tapmodels')
  assert.deepEqual(siteBranding(db), DEFAULT_BRANDING)
  const value = await saveSiteBranding(db, { name: 'Example', logo_url: '/logo.png' }, 'admin')
  assert.equal(siteBranding(db).name, 'Example')
  assert.equal(value.logo_url, '/logo.png')
  for (const logo_url of [
    'javascript:alert(1)',
    '//other.site/image',
    'data:text/html;base64,abc',
    'https://user:pass@example.com/logo',
  ])
    await assert.rejects(() => saveSiteBranding(db, { logo_url }, 'admin'), { code: 'invalid_brand_image' })
  await assert.rejects(() => saveSiteBranding(db, { name: '' }, 'admin'))
  await assert.rejects(() => saveSiteBranding(db, { role: 'super_admin' }, 'admin'))
})

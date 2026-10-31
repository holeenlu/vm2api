import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { saveSiteBranding, tryServeSiteIcon } from '../../src/lib/admin/site-branding.mjs'
import { tryServeWebDist } from '../../src/lib/http/web-dist.mjs'

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`

test('public favicon URLs use saved branding, refresh on edits, and restore default assets', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-favicon-'))
  const dist = path.join(root, 'web', 'dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'favicon.ico'), 'default-icon')
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (tryServeSiteIcon(res, pathname, db) || tryServeWebDist(res, root, pathname)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const original = await fetch(`${base}/favicon.ico`)
  assert.equal(await original.text(), 'default-icon')

  saveSiteBranding(db, { logo_url: png }, 'admin')
  let firstEtag
  for (const url of ['/favicon.ico', '/favicon.svg', '/images/favicon_32.png', '/images/favicon_512.png']) {
    const response = await fetch(base + url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'))
    firstEtag ??= response.headers.get('etag')
    assert.equal(response.headers.get('etag'), firstEtag)
  }
  const head = await fetch(`${base}/favicon.ico`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-type'), 'image/png')
  assert.equal(head.headers.get('etag'), firstEtag)
  assert.equal(await head.text(), '')
  const cached = await fetch(`${base}/favicon.ico`, { headers: { 'if-none-match': firstEtag } })
  assert.equal(cached.status, 304)
  assert.equal(await cached.text(), '')

  saveSiteBranding(db, { favicon_url: jpeg }, 'admin')
  const updated = await fetch(`${base}/favicon.ico?v=updated`, { headers: { 'if-none-match': firstEtag } })
  assert.equal(updated.status, 200)
  assert.equal(updated.headers.get('content-type'), 'image/jpeg')
  assert.notEqual(updated.headers.get('etag'), firstEtag)
  assert.deepEqual(Buffer.from(await updated.arrayBuffer()), Buffer.from(jpeg.split(',')[1], 'base64'))

  saveSiteBranding(db, { favicon_url: '', logo_url: '' }, 'admin')
  const restored = await fetch(`${base}/favicon.ico?v=default`)
  assert.equal(restored.status, 200)
  assert.equal(restored.headers.get('content-type'), 'image/x-icon')
  assert.equal(await restored.text(), 'default-icon')
})

test('URL images redirect without fetching and built-in references do not loop', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const res = {
    req: { method: 'GET', headers: { host: 'tapmodels.test' } },
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end() {},
  }
  for (const source of ['/brand.png', 'https://cdn.example.com/brand.png']) {
    saveSiteBranding(db, { favicon_url: source }, 'admin')
    assert.equal(tryServeSiteIcon(res, '/favicon.ico', db), true)
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, source)
    assert.match(res.headers['cache-control'], /must-revalidate/)
  }
  for (const source of ['/favicon.ico', '/favicon.svg?v=old', 'https://tapmodels.test/favicon.ico']) {
    saveSiteBranding(db, { favicon_url: source }, 'admin')
    assert.equal(tryServeSiteIcon(res, '/favicon.ico', db), false)
  }
  new SettingsRepo(db).set('site_branding', { favicon_url: 'javascript:alert(1)' })
  assert.equal(tryServeSiteIcon(res, '/favicon.ico', db), false)
  assert.equal(tryServeSiteIcon(res, '/assets/app.js', null), false)
  res.req.method = 'POST'
  assert.equal(tryServeSiteIcon(res, '/favicon.ico', null), false)
})

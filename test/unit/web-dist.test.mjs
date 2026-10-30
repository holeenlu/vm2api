import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { tryServeWebDist } from '../../src/lib/http/web-dist.mjs'

function mockRes(method = 'GET') {
  return {
    req: { method },
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

test('HEAD returns the same static headers as GET without reading file contents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-web-head-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dist = path.join(root, 'web', 'dist')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ok</title>')
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)')
  const paths = ['/console', '/console/', '/cc', '/cc/', '/assets/app.js']
  const gets = paths.map((entry) => {
    const res = mockRes()
    assert.equal(tryServeWebDist(res, root, entry), true)
    return res
  })
  t.mock.method(fs, 'readFileSync', () => assert.fail('HEAD must not read file contents'))
  for (const [index, entry] of paths.entries()) {
    const res = mockRes('HEAD')
    assert.equal(tryServeWebDist(res, root, entry), true)
    assert.equal(res.status, gets[index].status)
    assert.deepEqual(res.headers, gets[index].headers)
    assert.equal(res.body, undefined)
  }
  for (const entry of ['/assets/missing.js', '/../package.json', '/cc%ZZ']) {
    assert.equal(tryServeWebDist(mockRes('HEAD'), root, entry), false)
  }
})

test('serves Vite index at /console and assets from web/dist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-web-'))
  const dist = path.join(root, 'web', 'dist', 'assets')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>ok</title>')
  fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1)')

  const html = mockRes()
  assert.equal(tryServeWebDist(html, root, '/console'), true)
  assert.equal(html.status, 200)
  assert.match(String(html.headers['content-type']), /text\/html/)
  assert.match(String(html.body), /ok/)

  const js = mockRes()
  assert.equal(tryServeWebDist(js, root, '/assets/app.js'), true)
  assert.equal(js.status, 200)
  assert.match(String(js.headers['content-type']), /javascript/)
})

test('caches hashed assets forever but never the index or unhashed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-web-cache-'))
  const dist = path.join(root, 'web', 'dist')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dist, 'model-icons'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), 'x')
  fs.writeFileSync(path.join(dist, 'assets', 'index-Ab12.js'), 'x')
  fs.writeFileSync(path.join(dist, 'model-icons', 'openai.svg'), '<svg/>')

  const serve = (p) => {
    const res = mockRes()
    assert.equal(tryServeWebDist(res, root, p), true)
    return res.headers['cache-control']
  }
  assert.equal(serve('/console'), 'no-store')
  assert.equal(serve('/cc'), 'no-store')
  assert.equal(serve('/cc/'), 'no-store')
  assert.equal(serve('/index.html'), 'no-store')
  assert.match(serve('/assets/index-Ab12.js'), /immutable/)
  assert.doesNotMatch(serve('/model-icons/openai.svg'), /immutable/)
})

test('rejects missing dist, traversal, and /health', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-web-empty-'))
  assert.equal(tryServeWebDist(mockRes(), root, '/console'), false)

  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), 'x')
  assert.equal(tryServeWebDist(mockRes(), root, '/health'), false)
  assert.equal(tryServeWebDist(mockRes(), root, '/../package.json'), false)
})

test('serves the documented /cc entry as the console index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-web-cc-'))
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>cc</title>')
  for (const entry of ['/cc', '/cc/', '/console', '/console/']) {
    const res = mockRes()
    assert.equal(tryServeWebDist(res, root, entry), true, entry)
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /text\/html/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.match(String(res.body), /cc/)
  }
  assert.equal(tryServeWebDist(mockRes(), root, '/cc%'), false)
  assert.equal(tryServeWebDist(mockRes(), root, '/cc%ZZ'), false)
})

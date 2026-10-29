import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'

function runSync(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/sync-wrap-cli.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('container wrap sync waits for health then replaces every slot', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') {
      res.end('{"status":"ok"}')
      return
    }
    if (req.url === '/api/panel/wrap-cli/sync') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        requests.at(-1).body = body
        res.end('{"ok":true,"data":{"ok":true,"total":2,"ok_count":2,"failed_count":0}}')
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const result = await runSync({ KIN_AUTO_SYNC_BASE: `http://127.0.0.1:${port}`, TAPMODELS_API_KEY: 'test-key' })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /2\/2, failed=0/)
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ['GET', '/health'],
        ['POST', '/api/panel/wrap-cli/sync'],
      ],
    )
    assert.equal(requests[1].authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(requests[1].body), { restart: true })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('container wrap sync fails when any slot update fails', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') res.end('{"status":"ok"}')
    else res.end('{"ok":true,"data":{"ok":false,"total":2,"ok_count":1,"failed_count":1}}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const result = await runSync({ KIN_AUTO_SYNC_BASE: `http://127.0.0.1:${port}`, TAPMODELS_API_KEY: 'test-key' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /slot sync failed/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

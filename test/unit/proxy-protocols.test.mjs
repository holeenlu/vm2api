import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fetch from 'node-fetch'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool, parseProxyLine } from '../../src/lib/vm/proxy-pool.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'
import { createProxyAgent } from '../../src/lib/vm/proxy-agent.mjs'

function poolFor(t, options = {}) {
  const db = openDatabase({ dbPath: ':memory:' })
  t.after(closeDatabase)
  return new ProxyPool({ db, ...options })
}

test('protocol survives import, deduplication, update, persistence, VM and egress URL', (t) => {
  const pool = poolFor(t)
  for (const protocol of ['http', 'https', 'socks5', 'socks5h']) {
    const input = `${protocol}://user:p%40ss@proxy.example:8080`
    const row = pool.importLines(input).items[0]
    assert.equal(row.scheme, protocol)
    assert.equal(pool.importLines(input).added, 0)
    assert.equal(pool.getProxyByIdWithAuth(row.id).url, input)
    assert.equal(pool.bind(row.id, `vm-${protocol}`).ok, true)
    assert.equal(boundProxyUrl(pool.getProxyForVm(`vm-${protocol}`)), input)
  }
  assert.equal(pool.snapshot().proxies.length, 4)
  const id = pool.snapshot().proxies[0].id
  assert.equal(pool.update(id, { protocol: 'https', label: 'HTTPS endpoint' }).ok, true)
  pool.reload()
  assert.equal(pool.getProxyByIdWithAuth(id).scheme, 'https')
  assert.ok(pool.getProxyByIdWithAuth(id).url.startsWith('https://'))
  assert.doesNotMatch(JSON.stringify(pool.snapshot()), /p@ss|p%40ss/)
  assert.doesNotMatch(pool.state.proxies.find((p) => p.id === id).raw, /p@ss|p%40ss/)
  assert.equal(parseProxyLine('https://proxy.example').port, 443)
  assert.equal(parseProxyLine('http://proxy.example').port, 80)
  for (const bad of ['ftp://proxy.example:21', 'http://proxy.example:80/path', 'https://proxy.example?x=1'])
    assert.equal(parseProxyLine(bad), null)
  assert.equal(pool.update(id, { protocol: 'ftp', label: 'bad' }).ok, false)
  assert.equal(pool.snapshot().proxies.find((p) => p.id === id).label, 'HTTPS endpoint')
})

test('HTTP CONNECT uses the selected proxy and sends credentials only to that proxy', async (t) => {
  const seen = []
  const sockets = new Set()
  const server = http.createServer()
  server.on('connect', (req, socket) => {
    seen.push({ host: req.url, auth: req.headers['proxy-authorization'] })
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', (data) => {
      assert.doesNotMatch(data.toString(), /Proxy-Authorization/i)
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  const agent = createProxyAgent(`http://user:secret@127.0.0.1:${server.address().port}`)
  t.after(() => agent.destroy())
  const result = await fetch('http://remote.invalid/example', { agent, signal: AbortSignal.timeout(3000) })
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), {})
  assert.deepEqual(seen, [
    { host: 'remote.invalid:80', auth: `Basic ${Buffer.from('user:secret').toString('base64')}` },
  ])
})

test('expiry fallback respects capacity and cycles; failed switches keep existing binding', async (t) => {
  const moved = []
  const pool = poolFor(t, { onRebindVm: async (vm, proxy) => moved.push({ vm, id: proxy.id }) })
  pool.updateConfig({ bind_limit: 1 })
  const [source, backup] = pool.importLines('http://a.example:80\nhttps://b.example:443').items
  pool.bind(source.id, 'vm-a')
  pool.bind(backup.id, 'vm-b')
  assert.equal(pool.bind(backup.id, 'vm-a').error, 'proxy_bind_limit')
  assert.equal(pool.getProxyForVm('vm-a').id, source.id)
  assert.equal(
    pool.update(source.id, { expires_at: '2000-01-01T00:00:00Z', fallback_mode: 'proxy', backup_proxy_id: backup.id })
      .ok,
    true,
  )
  assert.equal(
    pool.update(backup.id, { fallback_mode: 'proxy', backup_proxy_id: source.id }).error,
    'proxy_fallback_cycle',
  )
  assert.equal(pool.getProxyForVm('vm-a'), null)
  await pool.sweepExpired()
  assert.equal(moved.length, 0)
  assert.deepEqual(pool.snapshot().proxies.find((p) => p.id === source.id).bound_vm_ids, ['vm-a'])
  pool.unbindVm('vm-b')
  await pool.sweepExpired()
  assert.deepEqual(moved, [{ vm: 'vm-a', id: backup.id }])
  assert.equal(pool.getProxyForVm('vm-a').id, backup.id)
  pool.reload()
  assert.equal(pool.snapshot().proxies.find((p) => p.id === source.id).fallback_mode, 'proxy')
  assert.equal(pool.update(source.id, { expires_at: 'invalid' }).error, 'invalid_expires_at')
})

test('manual connection check verifies an exit and never re-enables a manually disabled proxy', async (t) => {
  const urls = []
  const pool = poolFor(t, {
    geoLookup: async (url) => {
      urls.push(url)
      return { ok: true, geo: { ip: '192.0.2.1', timezone: 'Asia/Taipei' } }
    },
  })
  const id = pool.importLines('https://a.example:443').items[0].id
  pool.setEnabled(id, false)
  const result = await pool.probeById(id, { connectivity: true })
  assert.equal(result.probe.ok, true)
  assert.equal(result.proxy.enabled, false)
  assert.deepEqual(urls, ['https://a.example:443'])
})

test('editing a proxy while a connection test is pending discards the old exit result', async (t) => {
  let release, started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const pool = poolFor(t, {
    geoLookup: () =>
      new Promise((resolve) => {
        release = resolve
        started()
      }),
  })
  const id = pool.importLines('http://a.example:8080').items[0].id
  const running = pool.probeById(id, { connectivity: true })
  await ready
  pool.update(id, { port: 8081 })
  release({ ok: true, geo: { ip: '192.0.2.1' } })
  assert.equal((await running).error, 'proxy_changed_during_check')
  assert.equal(pool.snapshot().proxies.find((p) => p.id === id).geo, null)
})

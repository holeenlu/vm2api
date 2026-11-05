import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool, parseSocks5Line } from '../../src/lib/vm/proxy-pool.mjs'
import { boundProxyUrl } from '../../src/lib/vm/egress.mjs'

function poolFor(t, options = {}) {
  const db = openDatabase({ dbPath: ':memory:' })
  t.after(closeDatabase)
  return new ProxyPool({ db, ...options })
}

test('only SOCKS5 endpoints are accepted; other schemes are rejected instead of misparsed', (t) => {
  const pool = poolFor(t)
  const row = pool.importLines('socks5://user:p%40ss@proxy.example:1080').items[0]
  assert.equal(row.scheme, 'socks5')
  // The same endpoint and credentials spelled socks5h is the same proxy, not a second one.
  const again = pool.importLines('socks5h://user:p%40ss@proxy.example:1080')
  assert.equal(again.added, 0)
  assert.equal(again.skip_details[0].reason, 'duplicate')
  assert.equal(pool.snapshot().proxies.length, 1)
  assert.equal(pool.getProxyByIdWithAuth(row.id).url, 'socks5://user:p%40ss@proxy.example:1080')
  assert.equal(pool.bind(row.id, 'vm-1').ok, true)
  assert.equal(boundProxyUrl(pool.getProxyForVm('vm-1')), 'socks5h://user:p%40ss@proxy.example:1080')
  assert.doesNotMatch(JSON.stringify(pool.snapshot()), /p@ss|p%40ss/)
  assert.doesNotMatch(pool.state.proxies.find((p) => p.id === row.id).raw, /p@ss|p%40ss/)
  const only = row

  // `http://u:p@h:80` must not fall through to the user:pass@host:port form and become a
  // SOCKS5 proxy whose user name is "http".
  for (const bad of [
    'http://user:pass@proxy.example:80',
    'https://proxy.example:443',
    'ftp://proxy.example:21',
    'socks5://proxy.example:1080/path',
    'socks5://proxy.example:1080?x=1',
  ])
    assert.equal(parseSocks5Line(bad), null, bad)
  const rejected = pool.importLines('http://user:pass@proxy.example:80')
  assert.equal(rejected.added, 0)
  assert.equal(rejected.skip_details[0].reason, 'parse_failed')
  assert.equal(pool.snapshot().proxies.length, 1)

  // A protocol field on an edit is not an editable setting any more.
  assert.equal(pool.update(only.id, { protocol: 'http' }).error, 'no_editable_fields')
  assert.equal(pool.snapshot().proxies[0].host, 'proxy.example')
})

test('expiry fallback respects capacity and cycles; failed switches keep existing binding', async (t) => {
  const moved = []
  const pool = poolFor(t, { onRebindVm: async (vm, proxy) => moved.push({ vm, id: proxy.id }) })
  pool.updateConfig({ bind_limit: 1 })
  const [source, backup] = pool.importLines('socks5://a.example:1080\nsocks5://b.example:1081').items
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
  const id = pool.importLines('socks5://a.example:1080').items[0].id
  pool.setEnabled(id, false)
  const result = await pool.probeById(id, { connectivity: true })
  assert.equal(result.probe.ok, true)
  assert.equal(result.proxy.enabled, false)
  assert.deepEqual(urls, ['socks5://a.example:1080'])
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
  const id = pool.importLines('socks5://a.example:1080').items[0].id
  const running = pool.probeById(id, { connectivity: true })
  await ready
  pool.update(id, { port: 1081 })
  release({ ok: true, geo: { ip: '192.0.2.1' } })
  assert.equal((await running).error, 'proxy_changed_during_check')
  assert.equal(pool.snapshot().proxies.find((p) => p.id === id).geo, null)
})

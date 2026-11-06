// R6 B6c：VM、代理池、集群节点数据访问异步化的专项回归——临时同步出口（…Sync）与 async 版本结果一致，
// 代理池构造不再读库、改由 ProxyPool.create() 载入，已删除的出口不再导出。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxiesRepo } from '../../src/lib/db/repos/proxies-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import * as resources from '../../src/lib/vendor/repos/resources-repo.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b6c-r6-async-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}

const PROXIES = [
  { id: 'px-a', scheme: 'socks5', host: '203.0.113.1', port: 1080, platforms: ['openai'], bound_vm_id: 'vm-1' },
  { id: 'px-b', protocol: 'socks5', host: '203.0.113.2', port: 1081, enabled: false, domain_forward: true },
]

test('ProxiesRepo.replaceAllSync and replaceAll write the same rows', async (t) => {
  const { db } = fixture(t)
  const repo = new ProxiesRepo(db)
  repo.replaceAllSync(PROXIES)
  const viaSync = await repo.loadAll()
  await repo.replaceAll(PROXIES)
  const viaAsync = await repo.loadAll()
  const strip = (rows) => rows.map(({ created_at, updated_at, ...rest }) => rest)
  assert.deepEqual(strip(viaAsync), strip(viaSync))
  assert.deepEqual(
    viaAsync.map((p) => [p.id, p.scheme, p.enabled, p.domain_forward, p.name]),
    [
      ['px-a', 'socks5', true, false, '203.0.113.1:1080'],
      ['px-b', 'socks5', false, true, '203.0.113.2:1081'],
    ],
  )
  // async replaceAll is one transaction: a failing row leaves the previous set intact
  await assert.rejects(
    repo.replaceAll([
      { id: 'px-a', host: 'x', port: 1 },
      { id: 'px-a', host: 'y', port: 2 },
    ]),
  )
  assert.deepEqual(
    (await repo.loadAll()).map((p) => p.id),
    ['px-a', 'px-b'],
  )
})

test('ProxyPool constructor does not read the database; create() loads the working set', async (t) => {
  const { db } = fixture(t)
  const repo = new ProxiesRepo(db)
  repo.setConfig({ bind_limit: 3 })
  repo.replaceAllSync(PROXIES)
  const bare = new ProxyPool({ db })
  assert.deepEqual(bare.state.proxies, [])
  const pool = await ProxyPool.create({ db })
  assert.deepEqual(
    pool.state.proxies.map((p) => p.id),
    ['px-a', 'px-b'],
  )
  assert.equal(pool.state.config.bind_limit, 3)
  assert.equal((await pool.getProxyForVm('vm-1')).id, 'px-a')
  repo.replaceAllSync([PROXIES[1]])
  await pool.reload()
  assert.deepEqual(
    pool.state.proxies.map((p) => p.id),
    ['px-b'],
  )
})

test('VmsRepo sync exit matches the async upsert and read', async (t) => {
  const { db } = fixture(t)
  const repo = new VmsRepo(db)
  const vm = {
    id: 'vm-r6',
    name: 'r6',
    status: 'running',
    claude: { email: 'r6@example.test', access_token: 'secret' },
  }
  const viaSync = repo.upsertFromVmJsonSync(vm, { mtimeMs: 1000 })
  const viaAsync = await repo.upsertFromVmJson(vm, { mtimeMs: 1000 })
  const strip = ({ synced_at, updated_at, ...rest }) => rest
  assert.deepEqual(strip(viaAsync), strip(viaSync))
  assert.deepEqual(repo.getSync('vm-r6'), await repo.get('vm-r6'))
  assert.equal(viaAsync.vm.claude.access_token, undefined)
  assert.deepEqual(await repo.ids(), ['vm-r6'])
  assert.equal(await repo.count(), 1)
  assert.equal((await repo.list()).length, 1)
  assert.equal(await repo.remove('vm-r6'), true)
  assert.equal(await repo.get('vm-r6'), null)
})

test('ClusterNodesRepo.platformSync matches platform', async (t) => {
  const { db } = fixture(t)
  const repo = new ClusterNodesRepo(db)
  await repo.insert({
    id: 'node-r6',
    label: 'r6',
    host: 'r6.example.test',
    port: 22,
    username: 'root',
    auth_type: 'password',
    password: 'pw',
    host_key_alg: 'ssh-ed25519',
    host_key_sha256: 'SHA256:x',
  })
  assert.equal(repo.platformSync('node-r6'), await repo.platform('node-r6'))
  assert.equal(await repo.setPlatform('node-r6', 'darwin'), true)
  assert.equal(repo.platformSync('node-r6'), 'darwin')
  assert.equal(await repo.platform('node-r6'), 'darwin')
  assert.equal(repo.platformSync('node-gone'), null)
})

test('removed sync exits are no longer exported', () => {
  assert.equal(resources.findRuntimeVmVendorSync, undefined)
  assert.equal(typeof resources.findRuntimeVmVendor, 'function')
})

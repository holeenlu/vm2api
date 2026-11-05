import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PANEL_ROLES,
  ROUTE_AUTH,
  ROUTE_KINDS,
  ROUTES,
  matchRoute,
  routeTableGuard,
} from '../../src/lib/admin/route-table.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/capability-policy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

test('every route entry is well formed and unique', () => {
  const seen = new Set()
  for (const route of ROUTES) {
    const label = `${route.method} ${route.path}`
    assert.ok(METHODS.includes(route.method), `${label}: method`)
    assert.match(route.path, /^\/(?:api\/(?:panel|vendor|admin\/vendors)|admin)(?:\/[A-Za-z0-9_.:-]+)*$/, label)
    assert.ok(ROUTE_AUTH.includes(route.auth), `${label}: auth ${route.auth}`)
    assert.ok(ROUTE_KINDS.includes(route.kind), `${label}: kind ${route.kind}`)
    for (const role of route.roles) assert.ok(PANEL_ROLES.includes(role), `${label}: role ${role}`)
    if (route.roles.length)
      assert.ok(['panel', 'panel_pre_gate'].includes(route.auth), `${label}: roles only gate panel routes`)
    // 参数名不同但形状相同的两条视为重复
    const shape = `${route.method} ${route.path.replace(/:[^/]+/g, ':')}`
    assert.ok(!seen.has(shape), `${label}: duplicate`)
    seen.add(shape)
  }
})

test('literal segments win over parameters and HEAD falls back to GET', () => {
  assert.equal(matchRoute('GET', '/api/panel/vms/create-options').path, '/api/panel/vms/create-options')
  assert.equal(matchRoute('GET', '/api/panel/vms/vm-01').path, '/api/panel/vms/:id')
  assert.equal(matchRoute('HEAD', '/api/panel/vms').path, '/api/panel/vms')
  assert.equal(matchRoute('GET', '/api/panel/vms/vm-01/no-such-action'), null)
  assert.equal(matchRoute('DELETE', '/api/panel/site'), null)
})

test('the role gate follows the table', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/me', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/api-keys', 'user').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'admin').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'super_admin').ok, true)
  // 未登记的路由只有超管能进入角色门
  assert.equal(authorizePanelRoute('GET', '/api/panel/no-such-route', 'admin').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/no-such-route', 'super_admin').ok, true)
  for (const route of ROUTES)
    for (const role of PANEL_ROLES) {
      const sample = route.path.replace(/:[^/]+/g, '1')
      if (matchRoute(route.method, sample) !== route) continue
      assert.equal(
        authorizePanelRoute(route.method, sample, role).ok,
        route.roles.includes(role),
        `${route.method} ${sample} ${role}`,
      )
    }
})

test('unregistered routes are rejected in strict mode and only warned about otherwise', () => {
  const warnings = []
  const log = { warn: (message) => warnings.push(message) }
  assert.equal(routeTableGuard('GET', '/api/panel/vms', { env: { KIN_ROUTE_TABLE_STRICT: '1' }, log }), false)
  assert.equal(routeTableGuard('GET', '/api/panel/no-such', { env: { KIN_ROUTE_TABLE_STRICT: '1' }, log }), true)
  // 路径已登记、方法不对：交给处理器返回 405
  assert.equal(
    routeTableGuard('GET', '/api/vendor/accounts/a1/pause', { env: { KIN_ROUTE_TABLE_STRICT: '1' }, log }),
    false,
  )
  let clock = 1_000_000
  const now = () => clock
  assert.equal(routeTableGuard('GET', '/api/panel/no-such-2', { env: {}, log, now }), false)
  assert.equal(routeTableGuard('GET', '/api/panel/no-such-2', { env: {}, log, now }), false)
  assert.equal(warnings.length, 1, 'warnings are rate limited')
  clock += 10 * 60_000
  routeTableGuard('GET', '/api/panel/no-such-2', { env: {}, log, now })
  assert.equal(warnings.length, 2)
})

// 路由源码中出现的完整路径字面量都必须登记；只做前缀、字符串替换或交回外层路由的字面量列在这里
const NOT_ROUTES = new Map([
  ['/api/vendor', 'panel-routes 把 /api/admin/vendors 替换成 /api/vendor 共用处理代码'],
  ['/api/panel', 'relay-routes 截掉面板前缀后再匹配'],
  ['/api/panel/cluster', 'cluster-routes 截掉集群前缀后再匹配'],
  ['/admin/models/refresh', 'panel-routes 返回 false，交给外层路由处理'],
])

test('every route path literal in the route sources is registered', () => {
  const admin = path.join(ROOT, 'src/lib/admin')
  const files = [
    'src/lib/gateway-worker/gateway-routes.mjs',
    'src/lib/cluster/cluster-routes.mjs',
    ...fs
      .readdirSync(admin)
      .filter((name) => /routes\.mjs$/.test(name))
      .map((name) => `src/lib/admin/${name}`),
  ]
  const missing = []
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const match of source.matchAll(
      /(startsWith\(\s*)?'(\/(?:api\/(?:panel|vendor|admin\/vendors)|admin)(?:\/[A-Za-z0-9_.-]*)*)'/g,
    )) {
      if (match[1] || NOT_ROUTES.has(match[2])) continue
      if (!METHODS.some((method) => matchRoute(method, match[2]))) missing.push(`${file}: ${match[2]}`)
    }
  }
  assert.deepEqual(missing, [], `register these routes in src/lib/admin/route-table.mjs:\n${missing.join('\n')}`)
})

// 写路由都要有审计：处理器自己写（handler）或由面板按路由写（route）。下列写路由不落盘，不需要审计
const WRITES_WITHOUT_AUDIT = new Map([
  ['POST /api/panel/vms/:id/circuit/reset', '只重置进程内熔断状态'],
  ['POST /api/vendor/account-drafts', '草稿只在进程内存里，授权完成时由导入写审计'],
  ['POST /api/vendor/accounts', '固定返回 409，改走授权草稿'],
  ['POST /api/vendor/vms', '固定返回 409'],
  ['DELETE /api/vendor/vms/:resourceId', '固定返回 403'],
  ['PATCH /api/vendor/vms/:resourceId', '固定返回 403'],
])

test('every write route is audited by its handler or by the route', () => {
  for (const route of ROUTES) {
    assert.ok(['none', 'route', 'handler'].includes(route.audit), `${route.method} ${route.path}: audit ${route.audit}`)
    const key = `${route.method} ${route.path}`
    if (route.kind === 'write' && !WRITES_WITHOUT_AUDIT.has(key))
      assert.notEqual(route.audit, 'none', `${key}: a write route needs audit 'route' or 'handler'`)
    if (route.audit !== 'none') assert.notEqual(route.method, 'GET', `${key}: reads are not audited by route`)
  }
  for (const key of WRITES_WITHOUT_AUDIT.keys()) {
    const [method, path] = key.split(' ')
    assert.equal(ROUTES.find((route) => route.method === method && route.path === path)?.audit, 'none', key)
  }
})

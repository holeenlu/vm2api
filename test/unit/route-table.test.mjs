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

// 写入（write）、登录与票据（auth）、外部动作（action）和明文回显（…/reveal）都要声明审计：处理器自己写（handler）
// 或由面板按路由写（route）。下列路由不写审计，逐条写明原因；新增这几类路由时要么声明审计，要么在这里说明为什么不需要
const exempt = (reason, keys) => keys.map((key) => [key, reason])
const AUDIT_EXEMPT = new Map([
  // 写路由
  ...exempt('草稿只在进程内存里，授权完成时由导入写审计', ['POST /api/vendor/account-drafts']),
  ...exempt('固定返回 409，改走授权草稿', ['POST /api/vendor/accounts']),
  ...exempt('固定返回 409', ['POST /api/vendor/vms']),
  ...exempt('固定返回 403', ['DELETE /api/vendor/vms/:resourceId', 'PATCH /api/vendor/vms/:resourceId']),
  // 登录与会话
  ...exempt('公开登录入口：失败由登录限速约束，成功只签发会话，不改业务数据', ['POST /api/panel/login']),
  ...exempt('只吊销当前会话', ['POST /api/panel/logout']),
  ...exempt('读取当前会话身份', ['GET /api/panel/me']),
  // 只读的外部查询与探测：结果只更新探测快照或缓存，不改配置、凭据与归属
  ...exempt('面板试聊：只把请求转发给上游，不改配置或凭据', [
    'POST /api/panel/anthropic/messages',
    'POST /api/panel/api/messages',
    'POST /api/panel/vms/:id/test-chat',
    'POST /api/panel/codex-accounts/:accountId/test-chat',
  ]),
  ...exempt('只拉取上游模型列表或版本信息', [
    'POST /api/panel/api-endpoints/:id/fetch-models',
    'POST /api/panel/api-endpoints/fetch-models',
    'POST /api/panel/jev-intercept/models',
    'GET /api/panel/codex-client-profile/releases',
    'GET /api/panel/version',
  ]),
  ...exempt('决策模型地址测试：只请求已配置的决策地址，结果只更新该 Key 的探测状态（可用 / 暂停），不改配置与凭据', [
    'POST /api/panel/jev-intercept/probe',
    'POST /api/panel/jev-intercept/quota',
  ]),
  ...exempt('读取节点 Docker 状态与日志，不改容器', [
    'GET /api/panel/cluster/nodes/:nodeId/docker/containers',
    'GET /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId/logs',
    'GET /api/panel/cluster/nodes/:nodeId/docker/info',
  ]),
  ...exempt('节点连通与环境探测，不改节点配置', [
    'POST /api/panel/cluster/nodes/:nodeId/preflight',
    'POST /api/panel/cluster/nodes/:nodeId/probe',
    'POST /api/panel/cluster/nodes/probe',
  ]),
  ...exempt('只重建控制面到节点的 SSH 连接，不改节点配置', ['POST /api/panel/cluster/nodes/:nodeId/reconnect']),
  ...exempt('读取上游账号资料与订阅', [
    'GET /api/panel/codex-accounts/:accountId/avatar',
    'GET /api/panel/codex-accounts/:accountId/profile',
    'GET /api/panel/codex-accounts/:accountId/subscription',
    'GET /api/panel/oauth',
    'GET /admin/vm/oauth',
  ]),
  ...exempt('固定返回 400：重新授权只走已审计的授权草稿', ['POST /api/panel/codex-accounts/:accountId/reauthorize']),
  ...exempt('处理器没有这条分支：重新授权只走已审计的 gateway-drafts', [
    'POST /api/vendor/accounts/:accountId/reauthorize',
  ]),
  ...exempt('账号、VM 与 Worker 的连通、额度探测：结果只写探测快照', [
    'POST /api/panel/codex-accounts/:accountId/test',
    'POST /api/vendor/accounts/:accountId/test',
    'POST /api/panel/gateway-workers/:instanceId/capabilities',
    'POST /api/panel/gateway-workers/:instanceId/health',
    'POST /api/panel/health-probe',
    'POST /api/panel/probe',
    'POST /api/panel/usage-probe',
    'POST /api/panel/vms/:id/claude-reset/query',
    'GET /api/panel/vms/:id/diagnose',
    'POST /api/panel/vms/:id/exit-probe',
    'POST /api/panel/vms/:id/openai-quota/refresh',
    'POST /api/panel/vms/:id/probe',
    'POST /admin/vms/:vmId/probe',
    'POST /admin/vms/probe-all',
  ]),
  ...exempt('代理连通、质量与地理位置探测：结果只写探测快照，不读写凭据', [
    'POST /api/panel/proxies/:proxyId/geo',
    'POST /api/panel/proxies/:proxyId/probe',
    'POST /api/panel/proxies/:proxyId/quality-check',
    'POST /api/panel/proxies/geo',
    'POST /api/panel/proxies/probe',
    'POST /api/vendor/proxies/:proxyId/geo',
    'POST /api/vendor/proxies/:proxyId/probe',
    'POST /api/vendor/proxies/:proxyId/quality-check',
    'POST /api/vendor/proxies/geo',
    'POST /api/vendor/proxies/probe',
    'POST /api/vendor/proxies/quality-check',
    'POST /api/admin/vendors/proxies/:proxyId/geo',
    'POST /api/admin/vendors/proxies/:proxyId/probe',
    'POST /api/admin/vendors/proxies/:proxyId/quality-check',
    'POST /api/admin/vendors/proxies/geo',
    'POST /api/admin/vendors/proxies/probe',
    'POST /api/admin/vendors/proxies/quality-check',
  ]),
  ...exempt('按请求体预览，不保存', [
    'POST /api/panel/codex-client-profile/preview',
    'POST /api/panel/codex-privacy/preview',
  ]),
  ...exempt('立即执行一次与定时任务相同的告警检查或发送测试消息，不改配置', [
    'POST /api/panel/notify/check',
    'POST /api/panel/notify/test',
  ]),
  ...exempt('只读的号池事件流', ['GET /api/panel/pool/stream']),
])

const auditRequired = (route) => ['write', 'auth', 'action'].includes(route.kind) || /\/reveal$/.test(route.path)

test('write, auth, action and reveal routes declare audit or a written exemption', () => {
  for (const route of ROUTES) {
    assert.ok(['none', 'route', 'handler'].includes(route.audit), `${route.method} ${route.path}: audit ${route.audit}`)
    const key = `${route.method} ${route.path}`
    if (auditRequired(route) && !AUDIT_EXEMPT.has(key))
      assert.notEqual(route.audit, 'none', `${key}: declare audit 'route' or 'handler', or exempt it with a reason`)
    if (route.audit !== 'none') assert.notEqual(route.method, 'GET', `${key}: reads are not audited by route`)
  }
  for (const [key, reason] of AUDIT_EXEMPT) {
    const [method, path] = key.split(' ')
    const route = ROUTES.find((item) => item.method === method && item.path === path)
    assert.ok(route && auditRequired(route), `${key}: stale exemption`)
    assert.equal(route.audit, 'none', `${key}: exempt routes must not also declare audit`)
    assert.ok(reason.trim(), `${key}: exemption needs a reason`)
  }
})

test('high-risk operations named by the 2026-11-07 audit (P1-S6) are audited', () => {
  const expected = {
    'POST /api/panel/vms/:id/shell-ticket': 'handler',
    'POST /api/panel/cluster/nodes/:nodeId/shell-ticket': 'handler',
    'POST /api/panel/proxies/:proxyId/reveal': 'handler',
    'POST /api/panel/api-keys/:id/reveal': 'handler',
    'POST /api/panel/update': 'route',
    'POST /api/panel/vms/fleet-update': 'route',
    'POST /api/panel/vms/:id/circuit/reset': 'route',
    'POST /api/panel/cluster/nodes/:nodeId/docker/containers': 'route',
    'DELETE /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId': 'route',
    'POST /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId/restart': 'route',
    'POST /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId/start': 'route',
    'POST /api/panel/cluster/nodes/:nodeId/docker/containers/:containerId/stop': 'route',
  }
  for (const [key, audit] of Object.entries(expected)) {
    const [method, path] = key.split(' ')
    assert.equal(ROUTES.find((route) => route.method === method && route.path === path)?.audit, audit, key)
  }
})

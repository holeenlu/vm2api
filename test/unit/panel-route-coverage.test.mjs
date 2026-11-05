import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSrc = [
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-user-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-api-key-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-api-endpoint-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-backup-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-read-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-command-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-lifecycle-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-diagnose-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-probe-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-quota-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-test-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-credential-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-runtime-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-oauth-query-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-seed-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-package-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-reset-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-maintenance-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-oauth-mutation-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-provision-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/lib/admin/panel-vm-import-routes.mjs'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8'),
].join('\n')

function serverPanelHandlers(src) {
  const handlers = []
  const exact = /req\.method === '(GET|POST|PUT|PATCH|DELETE)' && (?:p|path) === '(\/api\/panel\/[^']+)'/g
  let match
  while ((match = exact.exec(src))) {
    const method = match[1]
    const pathName = match[2]
    handlers.push({ method, matchPath: (p) => p === pathName })
  }
  const regex =
    /req\.method === '(GET|POST|PUT|PATCH|DELETE)' && \/\^(\\\/api\\\/panel\\\/.+?)\$\/\.test\((?:p|path)\)/g
  while ((match = regex.exec(src))) {
    try {
      const method = match[1]
      const re = new RegExp('^' + match[2].replace(/\\\//g, '/') + '$')
      handlers.push({ method, matchPath: (p) => re.test(p) })
    } catch {}
  }
  return handlers
}

/** Panel routes the kin-console web UI calls. Sourced from the UI, asserted against the server only. */
const PANEL_ROUTE_SAMPLES = [
  ['POST', '/api/panel/login'],
  ['POST', '/api/panel/logout'],
  ['GET', '/api/panel/dashboard'],
  ['GET', '/api/panel/database/metrics'],
  ['GET', '/api/panel/version'],
  ['GET', '/api/panel/changelog'],
  ['POST', '/api/panel/update'],
  ['GET', '/api/panel/vms'],
  ['GET', '/api/panel/vms/vm-01'],
  ['PATCH', '/api/panel/vms/vm-01'],
  ['DELETE', '/api/panel/vms/vm-01'],
  ['POST', '/api/panel/vms/vm-01/schedulable'],
  ['POST', '/api/panel/vms/vm-01/cooldown/clear'],
  ['POST', '/api/panel/vms/vm-01/circuit/reset'],
  ['GET', '/api/panel/vms/vm-01/diagnose'],
  ['POST', '/api/panel/vms/vm-01/recover'],
  ['POST', '/api/panel/vms/vm-01/reload'],
  ['POST', '/api/panel/vms/vm-01/collect-identity'],
  ['POST', '/api/panel/vms/vm-01/probe'],
  ['POST', '/api/panel/vms/vm-01/test-chat'],
  ['GET', '/api/panel/vms/vm-01/test-schedule'],
  ['PUT', '/api/panel/vms/vm-01/test-schedule'],
  ['DELETE', '/api/panel/vms/vm-01/test-schedule'],
  ['GET', '/api/panel/test-schedule/default'],
  ['PUT', '/api/panel/test-schedule/default'],
  ['POST', '/api/panel/test-schedule/sync'],
  ['GET', '/api/panel/vms/vm-01/seed-settings'],
  ['PUT', '/api/panel/vms/vm-01/seed-settings'],
  ['GET', '/api/panel/vms/vm-01/official-cc-bootstrap'],
  ['POST', '/api/panel/vms/vm-01/official-cc-bootstrap'],
  ['POST', '/api/panel/vms/vm-01/reconcile-fingerprint'],
  ['POST', '/api/panel/vms/vm-01/oauth/generate-auth-url'],
  ['POST', '/api/panel/vms/vm-01/oauth/exchange-code'],
  ['POST', '/api/panel/vms/vm-01/oauth/to-setup-token'],
  ['POST', '/api/panel/vms/vm-01/oauth/refresh'],
  ['GET', '/api/panel/vms/vm-01/oauth/credential'],
  ['PUT', '/api/panel/vms/vm-01/oauth/credential'],
  ['POST', '/api/panel/vms/vm-01/start'],
  ['POST', '/api/panel/vms/vm-01/stop'],
  ['POST', '/api/panel/vms/vm-01/activate'],
  ['POST', '/api/panel/vms/vm-01/deactivate'],
  ['POST', '/api/panel/vms/vm-01/reset'],
  ['POST', '/api/panel/vms/vm-01/reset-fingerprint'],
  ['POST', '/api/panel/vms/vm-01/allocate-proxy'],
  ['POST', '/api/panel/vms/create'],
  ['GET', '/api/panel/vms/create-options'],
  ['GET', '/api/panel/vms/vm-01/package'],
  ['PUT', '/api/panel/vms/vm-01/package'],
  ['POST', '/api/panel/vms/package'],
  ['POST', '/api/panel/vms/import'],
  ['POST', '/api/panel/vms/fleet-update'],
  ['GET', '/api/panel/wrap-cli'],
  ['POST', '/api/panel/wrap-cli/sync'],
  ['POST', '/api/panel/wrap-cli/make'],
  ['POST', '/api/panel/wrap-cli/kernel'],
  ['POST', '/api/panel/wrap-cli/kernel/release'],

  ['POST', '/api/panel/vms/vm-01/wrap-cli/promote'],
  ['POST', '/api/panel/vms/vm-01/wrap-cli/repair'],

  ['POST', '/api/panel/vms/slot-policy'],
  ['POST', '/api/panel/probe'],
  ['GET', '/api/panel/health-probe'],
  ['POST', '/api/panel/health-probe'],
  ['GET', '/api/panel/usage-probe'],
  ['POST', '/api/panel/usage-probe'],
  ['GET', '/api/panel/routing'],
  ['PUT', '/api/panel/routing'],
  ['GET', '/api/panel/distill'],
  ['PUT', '/api/panel/distill'],
  ['GET', '/api/panel/model-policy'],
  ['PUT', '/api/panel/model-policy'],
  ['POST', '/api/panel/model-policy/reset'],
  ['POST', '/api/panel/model-policy/sync-worker'],
  ['GET', '/api/panel/pricing'],
  ['PUT', '/api/panel/pricing/overrides'],
  ['POST', '/api/panel/pricing/sync'],
  ['POST', '/api/panel/pricing/reprice'],
  ['GET', '/api/panel/notify'],
  ['POST', '/api/panel/notify/check'],
  ['POST', '/api/panel/notify/test'],
  ['GET', '/api/panel/api-keys'],
  ['POST', '/api/panel/api-keys'],
  ['PATCH', '/api/panel/api-keys/k1'],
  ['DELETE', '/api/panel/api-keys/k1'],
  ['POST', '/api/panel/api-keys/k1/reset-quota'],
  ['POST', '/api/panel/api-keys/k1/reveal'],
  ['POST', '/api/panel/api-keys/k1/rotate'],
  ['GET', '/api/panel/api-keys/k1/stats'],
  ['GET', '/api/panel/api-endpoints'],
  ['POST', '/api/panel/api-endpoints'],
  ['PATCH', '/api/panel/api-endpoints/e1'],
  ['DELETE', '/api/panel/api-endpoints/e1'],
  ['POST', '/api/panel/api-endpoints/e1/fetch-models'],
  ['POST', '/api/panel/api-endpoints/e1/keys'],
  ['DELETE', '/api/panel/api-endpoints/e1/keys/k1'],
  ['POST', '/api/panel/anthropic/messages'],
  ['GET', '/api/panel/proxies'],
  ['POST', '/api/panel/proxies/import'],
  ['POST', '/api/panel/proxies/probe'],
  ['POST', '/api/panel/proxies/geo'],
  ['PUT', '/api/panel/proxies/config'],
  ['POST', '/api/panel/proxies/p1/probe'],
  ['POST', '/api/panel/proxies/p1/geo'],
  ['POST', '/api/panel/proxies/p1/enable'],
  ['POST', '/api/panel/proxies/p1/disable'],
  ['POST', '/api/panel/proxies/p1/bind'],
  ['POST', '/api/panel/proxies/p1/unbind'],
  ['POST', '/api/panel/model-policy/sync-codex'],
  ['GET', '/api/panel/users'],
  ['POST', '/api/panel/users'],
  ['PATCH', '/api/panel/users/u1'],
  ['DELETE', '/api/panel/users/u1'],
  ['GET', '/api/panel/usage-logs'],
  ['GET', '/api/panel/usage-logs/summary'],
  ['GET', '/api/panel/usage-logs/filter-options'],
  ['GET', '/api/panel/usage-logs/active-sessions'],
  ['GET', '/api/panel/usage-logs/overview'],
  ['GET', '/api/panel/statistics'],
  ['GET', '/api/panel/statistics/leaderboard'],
]

test('panel route samples all have server handlers', () => {
  const handlers = serverPanelHandlers(serverSrc)
  assert.ok(handlers.length > 50, `expected panel handlers, got ${handlers.length}`)
  const factoryRoutes = [
    { methods: ['POST'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/test-chat$/.test(p) },
    { methods: ['GET', 'PUT', 'DELETE'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/test-schedule$/.test(p) },
    { methods: ['GET', 'PUT'], match: (p) => p === '/api/panel/test-schedule/default' },
    { methods: ['POST'], match: (p) => p === '/api/panel/test-schedule/sync' },
    {
      methods: ['POST'],
      match: (p) => /^\/api\/panel\/vms\/[^/]+\/(credential\/clear|reset-fingerprint|reconcile-fingerprint)$/.test(p),
    },
    { methods: ['POST'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/(reload|shell-ticket|collect-identity)$/.test(p) },
    { methods: ['GET'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/oauth\/(credential|setup-token-session)$/.test(p) },
    { methods: ['GET', 'PUT'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/seed-settings$/.test(p) },
    { methods: ['GET', 'PUT'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/package$/.test(p) },
    { methods: ['POST'], match: (p) => p === '/api/panel/vms/package' },
    { methods: ['POST'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/reset$/.test(p) },
    {
      methods: ['POST', 'PUT'],
      match: (p) =>
        /^\/api\/panel\/vms\/[^/]+\/oauth\/(generate-auth-url|exchange-code|credential|to-setup-token|refresh)$/.test(
          p,
        ),
    },
    { methods: ['POST'], match: (p) => p === '/api/panel/vms/schedule/hold' },
    { methods: ['POST'], match: (p) => p === '/api/panel/vms/schedule/resume' },
    {
      methods: ['POST'],
      match: (p) =>
        /^\/api\/panel\/vms\/[^/]+\/(schedulable|cooldown\/clear|circuit\/reset|activate|deactivate)$/.test(p),
    },
    { methods: ['POST'], match: (p) => /^\/api\/panel\/vms\/[^/]+\/update-claude-code$/.test(p) },
    { methods: ['DELETE'], match: (p) => /^\/api\/panel\/vms\/[^/]+$/.test(p) },
    { methods: ['POST'], match: (p) => p === '/api/panel/vms/create' },
    { methods: ['POST'], match: (p) => p === '/api/panel/vms/import' },
  ]
  const missing = []
  for (const [method, sample] of PANEL_ROUTE_SAMPLES) {
    const ok =
      handlers.some((handler) => handler.method === method && handler.matchPath(sample)) ||
      factoryRoutes.some((route) => route.methods.includes(method) && route.match(sample))
    if (!ok) missing.push(`${method} ${sample}`)
  }
  assert.deepEqual(missing, [])
})

test('ACL schedule POSTs still have handlers', () => {
  assert.match(serverSrc, /cooldown\\\/clear/)
  assert.match(serverSrc, /clearVmCooldown/)
  assert.match(serverSrc, /\/schedulable\$/)
})

test('settings save imports public routing notify helpers', () => {
  const routes = fs.readFileSync(path.join(root, 'src/lib/admin/panel-routes.mjs'), 'utf8')
  assert.match(
    routes,
    /import\s*\{[^}]*publicNotifyConfig[^}]*publicRoutingNotify[^}]*\}\s*from\s*['"]\.\/notify\.mjs['"]/,
  )
})

test('PUT proxy restarts kin-egress when connection or domain_forward changes', () => {
  const routes = fs.readFileSync(path.join(root, 'src/lib/admin/panel-routes.mjs'), 'utf8')
  assert.match(routes, /result\.domain_forward_changed \|\| result\.connection_changed/)
})

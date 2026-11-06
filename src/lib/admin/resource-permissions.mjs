/**
 * 账号资源权限：虚拟机、Codex（Gateway）账号与供应商账号池共用的一套
 * 「查看 / 创建 / 编辑 / 管理」能力。
 *
 *   resources.read    查看三类资源的列表、详情、用量；凭证只显示状态与掩码
 *   resources.create  新建 VM、新建或导入 Codex 账号（隐含查看）
 *   resources.edit    修改配置、分组、调度、暂停恢复、测试、重新授权或替换凭证（隐含查看）
 *   resources.manage  删除归档、重建、改归属、终端、打包导出、凭证明文查看与导出（隐含编辑、查看）
 *
 * super_admin 天然拥有全部能力；admin 只拥有 super_admin 显式授予的能力；
 * user / vendor 永远没有（供应商门户继续使用 vendor.resource.manage）。
 * 创建者不因创建而获得编辑权：能否修改只看能力与供应商归属。
 *
 * 这里同时维护 HTTP 方法/路径到所需能力的映射，前后端共用同一份判定。
 */

export const RESOURCE_PERMISSIONS = Object.freeze([
  'resources.read',
  'resources.create',
  'resources.edit',
  'resources.manage',
])

/** 三个资源入口对应的面板视图；拥有 resources.read 即可见。 */
export const RESOURCE_VIEWS = Object.freeze(['vm', 'codex-accounts', 'supplier-accounts'])

const IMPLIES = {
  'resources.read': [],
  'resources.create': ['resources.read'],
  'resources.edit': ['resources.read'],
  'resources.manage': ['resources.edit', 'resources.read'],
}

const LEVEL_CAP = {
  read: 'resources.read',
  create: 'resources.create',
  edit: 'resources.edit',
  manage: 'resources.manage',
}

/** 补齐隐含能力并按固定顺序去重；未知值丢弃。 */
export function normalizeResourcePermissions(list) {
  let raw = list
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw || '[]')
    } catch {
      raw = []
    }
  }
  const set = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const cap = String(item || '').trim()
    if (!IMPLIES[cap]) continue
    set.add(cap)
    for (const implied of IMPLIES[cap]) set.add(implied)
  }
  return RESOURCE_PERMISSIONS.filter((cap) => set.has(cap))
}

/** 角色与授予记录合成的有效能力。 */
export function resourcePermissionsFor(role, granted) {
  if (role === 'super_admin') return RESOURCE_PERMISSIONS.slice()
  if (role !== 'admin') return []
  return normalizeResourcePermissions(granted)
}

export function hasResourcePermission(permissions, level) {
  const cap = LEVEL_CAP[level] || level
  return Array.isArray(permissions) && permissions.includes(cap)
}

const VM_FLEET_MANAGE = new Set([
  '/api/panel/vms/reconcile-fingerprints',
  '/api/panel/vms/fleet-update',
  '/api/panel/vms/schedule/hold',
  '/api/panel/vms/schedule/resume',
])

const VM_CREATE = new Set(['/api/panel/vms/create', '/api/panel/vms/import', '/api/panel/vms/package'])

function vmRequirement(method, path) {
  if (path === '/api/panel/vms/create-options') return 'create'
  if (method === 'GET') {
    if (/^\/api\/panel\/vms\/[^/]+\/package$/.test(path)) return 'manage'
    if (/^\/api\/panel\/vms\/[^/]+\/shell$/.test(path)) return 'manage'
    if (/^\/api\/panel\/vms\/[^/]+\/diagnose$/.test(path)) return 'edit'
    return 'read'
  }
  if (VM_CREATE.has(path) || path.startsWith('/api/panel/vms/vm-import')) return 'create'
  if (VM_FLEET_MANAGE.has(path)) return 'manage'
  if (method === 'DELETE' && /^\/api\/panel\/vms\/[^/]+$/.test(path)) return 'manage'
  if (/^\/api\/panel\/vms\/[^/]+\/(reset|shell|shell-ticket|package|seed-settings)$/.test(path)) return 'manage'
  return 'edit'
}

function codexRequirement(method, path) {
  const base = '/api/panel/codex-accounts'
  if (path === base + '/export') return 'manage'
  if (path === base + '/import-file' || path === base + '/drafts' || path.startsWith(base + '/drafts/')) return 'create'
  if (method === 'GET') return 'read'
  if (method === 'DELETE') return 'manage'
  return 'edit'
}

function supplierAccountRequirement(method, path) {
  const base = '/api/admin/vendors/accounts'
  if (method === 'GET') return 'read'
  if (path === base) return method === 'POST' ? 'create' : null
  if (method === 'DELETE') return 'manage'
  return 'edit'
}

/**
 * 资源路由所需的能力等级；返回 null 表示不是资源路由，由原有角色策略决定。
 * 字段级要求（改归属、归档、凭证明文）由处理函数用 hasResourcePermission 再判。
 */
export function resourceRouteRequirement(method, path) {
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')
  if (p === '/api/panel/vms' || p.startsWith('/api/panel/vms/')) return vmRequirement(m, p)
  if (p === '/api/panel/codex-accounts' || p.startsWith('/api/panel/codex-accounts/')) return codexRequirement(m, p)
  if (m === 'GET' && p === '/api/admin/vendors') return 'read'
  // 供应商账号池：账号本身及其创建时选择的供应商代理；供应商其余管理页仍只属于 super_admin。
  if (p === '/api/admin/vendors/accounts' || p.startsWith('/api/admin/vendors/accounts/'))
    return supplierAccountRequirement(m, p)
  if (m === 'GET' && p === '/api/admin/vendors/proxies') return 'read'
  // 资源工作台的辅助读取：分组、代理、席位流、测试模型、默认定时测试。
  if (m === 'GET' && (p === '/api/panel/groups' || /^\/api\/panel\/groups\/\d+$/.test(p))) return 'read'
  if (m === 'GET' && (p === '/api/panel/proxies' || p === '/api/panel/pool/stream')) return 'read'
  if (m === 'GET' && (p === '/api/panel/test-models' || p === '/api/panel/test-schedule/default')) return 'read'
  if (/^\/api\/panel\/proxies\/[^/]+\/(bind|unbind|probe|geo)$/.test(p)) return 'edit'
  return null
}

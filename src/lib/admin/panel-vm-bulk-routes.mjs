import { getDb } from '../db/database.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { createVmBulkEditService } from './vm-bulk-edit.mjs'

export function createPanelVmBulkRoutes(ctx) {
  let service
  return async (req, res, url) => {
    const base = '/api/panel/vms/bulk-edit'
    const path = url.pathname
    const operation = path.match(/^\/api\/panel\/vms\/bulk-edit\/operations\/([a-zA-Z0-9_-]+)$/)
    if (!((req.method === 'POST' && [base, `${base}/snapshot`].includes(path)) || (req.method === 'GET' && operation)))
      return false
    const identity = panelIdentity(req)
    try {
      if (identity.role !== 'super_admin')
        throw Object.assign(new Error('当前权限无法执行此操作'), { status: 403, code: 'forbidden' })
      service ||= createVmBulkEditService({
        db: ctx.db || ctx.apiKeyStore?.db || getDb(),
        project: ctx.cfg.paths.project,
        applyVmConcurrency: (...args) => ctx.applyVmConcurrency(...args),
        applyVmRpm: (...args) => ctx.applyVmRpm(...args),
        inheritVmScheduling: (...args) => ctx.inheritVmScheduling(...args),
      })
      const actor = identity.user || req.panelUserId || 'master'
      const body = req.method === 'POST' ? await ctx.readBody(req, 1024 * 1024) : null
      const data = operation
        ? service.get(operation[1], actor)
        : path.endsWith('/snapshot')
          ? service.snapshot(body?.ids)
          : service.save(body, actor)
      ctx.json(res, 200, { ok: true, data })
    } catch (e) {
      ctx.json(res, e.status || 500, {
        ok: false,
        error: {
          code: e.code || 'bulk_edit_failed',
          message: e.status ? e.message : '批量操作未确认，请查询状态后重试',
        },
      })
    }
    return true
  }
}

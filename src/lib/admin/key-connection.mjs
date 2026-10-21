import { keyScopeFromRecord } from './key-scope.mjs'
import { keyModelCatalog } from '../protocol/key-models.mjs'
import { relayError } from './relay-common.mjs'

export function keyConnection(rec, ctx) {
  const scope = keyScopeFromRecord(rec, ctx.apiKeyStore.db)
  if (scope.error) throw relayError(scope.error, '分组不可用或无权调用', 403)
  const api = (scope.allowed_endpoints || []).length > 0 || (scope.platform && rec.category === 'api')
  const catalog = keyModelCatalog({ scope, api, apiScheduler: ctx.apiScheduler, projectRoot: ctx.cfg.paths.project })
  const models = catalog.data.map((m) => ({ id: m.id, name: m.display_name || m.id }))
  return {
    base_url: ctx.cfg.base_url || null,
    platform: scope.group_type,
    models,
    websocket: !api && ['openai', 'all'].includes(scope.group_type),
    standalone_search: !api && ['openai', 'all'].includes(scope.group_type),
  }
}

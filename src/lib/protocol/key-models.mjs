import { keyAllowsModel } from '../admin/key-scope.mjs'
import { slotAllowsModel } from '../pool/slot-model-gate.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { gatewayModelCatalog } from './models.mjs'

/** The connection dialog and both /v1/models formats share the inference route's model scope. */
export function keyModelCatalog({ scope, api = false, apiScheduler, projectRoot }) {
  const catalog = api
    ? apiScheduler.catalog(scope.platform ? null : scope.allowed_endpoints)
    : gatewayModelCatalog({ groupType: scope.group_type })
  const members = scope.platform || api ? [] : scope.allowed_vms.map((id) => getVm(projectRoot, id)).filter(Boolean)
  const data = catalog.data.filter(
    (model) =>
      keyAllowsModel(scope, model.id) &&
      (scope.platform ||
        (api
          ? scope.allowed_endpoints.length > 0
          : members.some(
              (vm) =>
                (isCodexVm(vm) ? 'openai' : 'anthropic') === detectInboundPlatform(model.id).platform &&
                slotAllowsModel({ vm, model: model.id }).ok,
            ))),
  )
  return { ...catalog, data }
}

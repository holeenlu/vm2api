import { oauthCredentialState, oauthCredentialView, oauthVmPaths } from '../oauth/oauth-route-context.mjs'
import { identityCanResource } from './panel-acl.mjs'

/** Read-only OAuth credential and setup session routes. */
export function createPanelVmOauthQueryRoutes({
  cfg,
  json,
  panel,
  panelIdentity,
  getVm,
  readWorkerCredentialFile,
  oauthToSub2apiExport,
  readSetupTokenSession,
  setupTokenFlavor,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmOauthQueryRoutes(req, res, route) {
    const credential = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/credential$/)
    if (credential && req.method === 'GET') {
      const id = credential[1]
      const vm = getVm(cfg.paths.project, id)
      if (!vm) return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      const cred = readWorkerCredentialFile(oauthVmPaths(cfg.paths.project, id).homeDir)
      // 明文凭证（access / refresh token、api key）只给「管理」；查看与编辑只得到状态
      const reveal = identityCanResource(panelIdentity(req), 'manage')
      return respond(
        res,
        200,
        panel.ok({
          ...oauthCredentialView({ ...vm, id }, cred || {}),
          credential_state: oauthCredentialState(vm, cred),
          export: reveal
            ? oauthToSub2apiExport(
                {
                  ...vm,
                  email: vm.email || vm.claude?.email,
                  account_uuid: vm.account_uuid || vm.claude?.account_uuid,
                  org_uuid: vm.org_uuid || vm.claude?.org_uuid,
                  max_concurrency: vm.max_concurrency ?? vm.policy?.maxConcurrency,
                },
                cred || {},
              )
            : null,
          ...(reveal ? {} : { export_redacted: true }),
        }),
      )
    }

    const setup = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/setup-token-session$/)
    if (setup && req.method === 'GET') {
      const id = setup[1]
      const session = readSetupTokenSession(cfg.paths.project, id)
      if (!session?.auth_url || session.expired || !session.alive)
        return respond(res, 200, panel.ok({ active: false, vm_id: id }))
      return respond(
        res,
        200,
        panel.ok({
          active: true,
          session_id: session.session_id,
          auth_url: session.auth_url,
          expires_at: session.expires_at,
          vm_id: id,
          flavor: setupTokenFlavor,
          source: session.source,
          status: session.status,
          error: session.error || null,
          retryable: true,
        }),
      )
    }
    return false
  }
}

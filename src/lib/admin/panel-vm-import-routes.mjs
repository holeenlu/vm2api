import { classifyClaudePaste, resolveCodexPaste, sessionKeyOauth } from '../oauth/credential-paste.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'

/** VM credential import adapter. */
export function createPanelVmImportRoutes(deps) {
  const {
    cfg,
    fs,
    path,
    json,
    readBody,
    panel,
    ctx,
    summarizeVm,
    panelImportErrorPayload,
    requireSlotProxy,
    slotExec,
    isCodexVm,
    refreshCodexAccessToken,
    commitImportedCodexVm,
    sessionKeyToOAuth,
    enrichOauthIdentity,
    assertVendorRuntimeVm,
    commitImportedOauth,
  } = deps
  // 写完响应即视为已处理：panel-routes 按返回值决定是否继续匹配后面的路由
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmImportRoutes(req, res, route) {
    const p = route
    // POST /api/panel/vms/import
    // workflow: create VM → allocate proxy → import sessionKey (via SOCKS) → start
    if (req.method === 'POST' && p === '/api/panel/vms/import') {
      const body = await readBody(req, 1024 * 1024)
      const vmId = body.vm_id || body.id || null
      try {
        if (!vmId) {
          return respond(res, 400, { ok: false, error: { message: 'vm_id required (先创建虚拟机)' } })
        }
        // vm_id 拼进文件路径，先按 VM 标识格式校验（审计 P2：管理员路径不经供应商归属校验，曾可路径穿越）
        if (!isValidVmId(String(vmId))) {
          return respond(res, 400, { ok: false, error: { code: 'invalid_vm_id', message: 'vm_id 无效' } })
        }
        await assertVendorRuntimeVm(req, vmId)
        const vmPath = path.join(cfg.paths.project, 'vms', `${vmId}.json`)
        if (!fs.existsSync(vmPath)) {
          return respond(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || vmId
        if (isCodexVm(existing)) {
          let proxyFailure = null
          const resolved = await resolveCodexPaste(body, async (refreshToken) => {
            const slotProxy = await requireSlotProxy(existing, body)
            if (!slotProxy.ok) {
              proxyFailure = slotProxy
              return null
            }
            return refreshCodexAccessToken({ refreshToken, proxyUrl: slotProxy.proxyUrl })
          })
          if (proxyFailure)
            return respond(res, proxyFailure.status, {
              ok: false,
              error: { code: 'proxy_required', message: proxyFailure.message },
            })
          if (!resolved.ok && resolved.stage === 'parse')
            return respond(res, 400, { ok: false, error: { code: resolved.code, message: resolved.message } })
          if (!resolved.ok)
            return respond(res, 502, {
              ok: false,
              error: {
                code: resolved.result?.error || 'refresh_failed',
                message: 'Refresh Token 换票失败，请检查 RT 或改用 OAuth / 账号文件。',
              },
            })
          await assertVendorRuntimeVm(req, vmId)
          const committed = await commitImportedCodexVm({
            cfg,
            vmPath,
            existing,
            account: resolved.account,
            catalogClientVersion: ctx.routingConfig.codex?.catalog_client_version,
            routingConfig: ctx.routingConfig,
          })
          return respond(res, 200, panel.ok(committed))
        }

        const paste = classifyClaudePaste(body, existing)
        const slotProxy = await requireSlotProxy(existing, body)
        if (['apikey', 'invalid_api_key', 'session_key'].includes(paste.kind) && !slotProxy.ok) {
          return respond(res, slotProxy.status, { ok: false, error: { message: slotProxy.message } })
        }
        if (paste.kind === 'invalid_api_key')
          return respond(res, 400, { ok: false, error: { message: '需要 sk-ant-api03-… Console API Key' } })
        if (paste.kind === 'missing')
          return respond(res, 400, { ok: false, error: { message: 'sessionKey or access_token required' } })
        const proxyUrl = slotProxy.proxyUrl
        let oauth = paste.oauth
        if (paste.kind === 'session_key') {
          oauth = sessionKeyOauth(
            await sessionKeyToOAuth(paste.sessionKey, {
              exec: slotExec(cfg.paths.project, existing),
              projectRoot: cfg.paths.project,
              routing: ctx.routingConfig,
              proxyUrl,
              scope: paste.scope,
            }),
            paste,
          )
        }
        // 槽位内换票已带身份；粘贴的 Access Token 与 sub2api 导出需要补查
        if (oauth.access_token && ['sub2api', 'access_token'].includes(paste.kind)) {
          oauth = await enrichOauthIdentity(oauth, { proxyUrl })
        }
        await assertVendorRuntimeVm(req, vmId)
        const committed = await commitImportedOauth({
          vmId,
          vmPath,
          existing,
          oauth,
          source: oauth.source || 'sessionKey-cookie-auth',
          name: body.name,
        })
        if (!committed.ok) {
          return respond(res, committed.status || 502, { ok: false, error: committed.error })
        }
        return respond(
          res,
          200,
          panel.ok({
            vm: await summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
            proxy_used: !!proxyUrl,
            oauth_email: existing.claude.email,
            has_refresh: existing.claude.has_refresh,
            official_cc_bootstrap: committed.official_cc_bootstrap || null,
          }),
        )
      } catch (e) {
        const fail = panelImportErrorPayload(e)
        return respond(res, fail.status, { ok: false, error: fail.error })
      }
    }

    return false
  }
}

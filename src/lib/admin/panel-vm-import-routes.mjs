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
    parseCodexImportPayload,
    refreshCodexAccessToken,
    commitImportedCodexVm,
    looksLikeConsoleApiKey,
    looksLikeOfficialSetupToken,
    sessionKeyToOAuth,
    isSub2apiAccountExport,
    sub2apiAccountToOauth,
    enrichOauthIdentity,
    assertVendorRuntimeVm,
    commitImportedOauth,
    invalidateLiveCredentialCache,
  } = deps
  return async function handlePanelVmImportRoutes(req, res, route) {
    const p = route
    // POST /api/panel/vms/import
    // workflow: create VM → allocate proxy → import sessionKey (via SOCKS) → start
    if (req.method === 'POST' && p === '/api/panel/vms/import') {
      const body = await readBody(req, 1024 * 1024)
      const sessionKey = body.sessionKey || body.session_key || body.sid || ''
      const accessToken = body.access_token || body.token || ''
      const apiKeyRaw = body.api_key || body.apiKey || ''
      const requestedType = body.type || body.credential_mode || body.scope || ''
      const vmId = body.vm_id || body.id || null
      const exportDoc = body.sub2api || body.account || body
      try {
        if (!vmId) {
          return json(res, 400, { ok: false, error: { message: 'vm_id required (先创建虚拟机)' } })
        }
        assertVendorRuntimeVm(req, vmId)
        const vmPath = path.join(cfg.paths.project, 'vms', `${vmId}.json`)
        if (!fs.existsSync(vmPath)) {
          return json(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
        }
        const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
        existing.id = existing.id || vmId
        if (isCodexVm(existing)) {
          const parsed = parseCodexImportPayload(body)
          if (!parsed.ok) {
            return json(res, 400, {
              ok: false,
              error: { code: parsed.error || 'invalid_codex_credential', message: parsed.message },
            })
          }
          const account = { ...parsed.account }
          if (!account.access_token && account.refresh_token) {
            const slotProxy = requireSlotProxy(existing, body)
            if (!slotProxy.ok) {
              return json(res, slotProxy.status, {
                ok: false,
                error: { code: 'proxy_required', message: slotProxy.message },
              })
            }
            const tok = await refreshCodexAccessToken({
              refreshToken: account.refresh_token,
              proxyUrl: slotProxy.proxyUrl,
            })
            if (!tok.ok) {
              return json(res, 502, {
                ok: false,
                error: {
                  code: tok.error || 'refresh_failed',
                  message: 'Refresh Token 换票失败，请检查 RT 或改用 OAuth / 账号文件。',
                },
              })
            }
            account.access_token = tok.access_token
            account.refresh_token = tok.refresh_token || account.refresh_token
            account.id_token = tok.id_token || account.id_token
            account.expires_at = tok.expires_at || account.expires_at
          }
          assertVendorRuntimeVm(req, vmId)
          const committed = await commitImportedCodexVm({
            cfg,
            vmPath,
            existing,
            account,
            catalogClientVersion: ctx.routingConfig.codex?.catalog_client_version,
            routingConfig: ctx.routingConfig,
          })
          return json(res, 200, panel.ok(committed))
        }

        const slotProxy = requireSlotProxy(existing, body)
        const wantsApiKey =
          looksLikeConsoleApiKey(apiKeyRaw || sessionKey || accessToken) ||
          String(requestedType).toLowerCase() === 'apikey' ||
          String(requestedType).toLowerCase() === 'console'
        if ((sessionKey || wantsApiKey) && !slotProxy.ok) {
          return json(res, slotProxy.status, { ok: false, error: { message: slotProxy.message } })
        }
        const proxyUrl = slotProxy.proxyUrl
        let oauth = null
        let oauthFromVm = false
        if (wantsApiKey) {
          const apiKey = String(apiKeyRaw || sessionKey || accessToken).trim()
          if (!looksLikeConsoleApiKey(apiKey)) {
            return json(res, 400, { ok: false, error: { message: '需要 sk-ant-api03-… Console API Key' } })
          }
          oauth = {
            type: 'apikey',
            mode: 'apikey',
            api_key: apiKey,
            access_token: apiKey,
            base_url: body.base_url || body.baseUrl || 'https://api.anthropic.com',
            source: 'console-api-key',
            auth_scheme: body.auth_scheme || body.authScheme,
          }
        } else if (sessionKey) {
          oauthFromVm = true
          const inference =
            String(requestedType).toLowerCase() === 'inference' ||
            String(requestedType).toLowerCase() === 'setup-token' ||
            String(requestedType).toLowerCase() === 'setup_token' ||
            String(body.scope || '').toLowerCase() === 'inference'
          oauth = await sessionKeyToOAuth(String(sessionKey).trim(), {
            exec: slotExec(cfg.paths.project, existing),
            projectRoot: cfg.paths.project,
            routing: ctx.routingConfig,
            proxyUrl,
            scope: inference ? 'inference' : 'full',
          })
          if (inference) {
            oauth.type = 'setup-token'
            oauth.mode = 'setup-token'
          }
        } else if (isSub2apiAccountExport(exportDoc)) {
          oauth = sub2apiAccountToOauth(exportDoc, existing)
        } else if (accessToken) {
          const inference =
            String(requestedType).toLowerCase() === 'inference' ||
            String(requestedType).toLowerCase() === 'setup-token' ||
            String(requestedType).toLowerCase() === 'setup_token' ||
            String(body.scope || '').toLowerCase() === 'inference'
          oauth = {
            access_token: String(accessToken).trim(),
            refresh_token: body.refresh_token || null,
            expires_at: body.expires_at || null,
            email: body.email || null,
            account_uuid: body.account_uuid || null,
            org_uuid: body.org_uuid || null,
            scope: body.scope || (inference ? 'user:inference' : null),
            source: body.source || (inference ? 'claude-setup-token' : 'access-token'),
          }
          if (looksLikeOfficialSetupToken(accessToken) || (inference && !String(body.refresh_token || '').trim())) {
            oauth.type = 'official-setup-token'
            oauth.mode = 'official-setup-token'
            oauth.refresh_token = ''
            oauth.scope = 'user:inference'
            oauth.source = body.source || 'claude-setup-token'
            if (!oauth.expires_at) oauth.expires_at = Date.now() + 365 * 24 * 60 * 60 * 1000
          } else if (inference) {
            oauth.type = 'setup-token'
            oauth.mode = 'setup-token'
          }
        } else {
          return json(res, 400, { ok: false, error: { message: 'sessionKey or access_token required' } })
        }
        if (body.auth_scheme || body.authScheme) oauth.auth_scheme = body.auth_scheme || body.authScheme
        if (oauth.access_token && !wantsApiKey && !oauthFromVm) {
          oauth = await enrichOauthIdentity(oauth, { proxyUrl })
        }
        assertVendorRuntimeVm(req, vmId)
        const committed = await commitImportedOauth({
          vmId,
          vmPath,
          existing,
          oauth,
          source: oauth.source || 'sessionKey-cookie-auth',
          name: body.name,
        })
        if (!committed.ok) {
          return json(res, committed.status || 502, { ok: false, error: committed.error })
        }
        return json(
          res,
          200,
          panel.ok({
            vm: summarizeVm(existing, cfg.paths.project, ctx.routingConfig),
            proxy_used: !!proxyUrl,
            oauth_email: existing.claude.email,
            has_refresh: existing.claude.has_refresh,
            official_cc_bootstrap: committed.official_cc_bootstrap || null,
          }),
        )
      } catch (e) {
        const fail = panelImportErrorPayload(e)
        return json(res, fail.status, { ok: false, error: fail.error })
      }
    }

    return false
  }
}

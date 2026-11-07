/** OAuth credential mutations for panel VMs. */
export function createPanelVmOauthMutationRoutes({
  cfg,
  fs,
  path,
  json,
  readBody,
  panel,
  proxyPool,
  requireSlotProxy,
  slotProxyHint,
  getVm,
  summarizeVm,
  isCodexVm,
  generateCodexAuthUrl,
  startClaudeAuthLoginSession,
  normalizeOauthFlavor,
  setupTokenFlavor,
  authLoginFlavor,
  authLoginSource,
  generateAuthUrl,
  exchangeCodexAuthCode,
  readAuthLoginSession,
  looksLikeOfficialSetupToken,
  completeClaudeSetupToken,
  completeClaudeAuthLogin,
  exchangeAuthCode,
  slotExec,
  enrichOauthIdentity,
  assertVendorRuntimeVm,
  commitImportedCodexVm,
  commitImportedOauth,
  parseCredentialEdit,
  readWorkerCredentialFile,
  isApiKeyMode,
  isOfficialSetupTokenMode,
  isSetupTokenMode,
  liveOauthToSetupToken,
  readCodexAccounts,
  refreshCodexAccessToken,
  hostProxyUrlForVm,
  upsertCodexAccount,
  oauthCredentialState,
  refreshWorkerCredentialForVm,
  refreshAccountProfile,
  invalidateLiveCredentialCache,
  routingConfig,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }
  return async function handlePanelVmOauthMutationRoutes(req, res, route) {
    const generate = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/generate-auth-url$/)
    if (generate && req.method === 'POST') {
      const id = generate[1]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
      const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.id = existing.id || id
      const body = await readBody(req, 8 * 1024)
      const slotProxy = await requireSlotProxy(existing, body)
      if (!slotProxy.ok)
        return respond(res, slotProxy.status, {
          ok: false,
          error: { code: 'proxy_required', message: slotProxy.message },
        })
      try {
        if (isCodexVm(existing)) {
          const generated = generateCodexAuthUrl({
            vmId: id,
            proxyUrl: slotProxy.proxyUrl,
            installationId: existing.device_id || existing.codex?.installation_id,
          })
          return respond(
            res,
            200,
            panel.ok({
              ...generated,
              proxy_hint: slotProxyHint(existing.proxy || {}, proxyPool?.labelOf(existing.proxy?.id)),
            }),
          )
        }
        const flavor = body.flavor || body.type || 'cai'
        if (normalizeOauthFlavor(flavor) === 'claude_code') {
          const generated = await startClaudeAuthLoginSession({
            vm: existing,
            projectRoot: cfg.paths.project,
            force: body.force === true || body.force === 'true' || body.force === 1,
          })
          return respond(
            res,
            200,
            panel.ok({
              ...generated,
              proxy_hint: slotProxyHint(existing.proxy || {}, proxyPool?.labelOf(existing.proxy?.id)),
            }),
          )
        }
        const generated = generateAuthUrl({ vmId: id, proxyUrl: slotProxy.proxyUrl, flavor })
        return respond(
          res,
          200,
          panel.ok({
            ...generated,
            proxy_hint: slotProxyHint(existing.proxy || {}, proxyPool?.labelOf(existing.proxy?.id)),
          }),
        )
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: {
            code: error.code || 'generate_auth_url_failed',
            message: String(error.message || error).slice(0, 240),
          },
        })
      }
    }

    const exchange = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/exchange-code$/)
    if (exchange && req.method === 'POST') {
      const id = exchange[1]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { message: 'vm not found, 请先创建种子虚拟机' } })
      const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.id = existing.id || id
      const body = await readBody(req, 16 * 1024)
      const slotProxy = await requireSlotProxy(existing, body)
      if (!slotProxy.ok)
        return respond(res, slotProxy.status, {
          ok: false,
          error: { code: 'proxy_required', message: slotProxy.message },
        })
      try {
        if (isCodexVm(existing)) {
          const oauth = await exchangeCodexAuthCode({
            sessionId: body.session_id || body.sessionId,
            code: body.code || body.auth_code || body.callback || body.callback_url,
            proxyUrl: slotProxy.proxyUrl,
            vmId: id,
          })
          await assertVendorRuntimeVm(req, id)
          const committed = await commitImportedCodexVm({
            cfg,
            vmPath,
            existing,
            catalogClientVersion: routingConfig.codex?.catalog_client_version,
            routingConfig,
            account: {
              access_token: oauth.access_token,
              refresh_token: oauth.refresh_token,
              id_token: oauth.id_token,
              expires_at: oauth.expires_at,
            },
          })
          return respond(res, 200, panel.ok({ ...committed, source: oauth.source, flavor: 'codex' }))
        }
        const code = body.code || body.auth_code || ''
        const flavor = body.flavor || body.type || ''
        const loginSession = readAuthLoginSession(cfg.paths.project, id)
        const sessionKey = String(body.session_id || body.sessionId || '')
        const officialLogin =
          normalizeOauthFlavor(flavor) === 'claude_code' ||
          (loginSession?.alive &&
            !loginSession.expired &&
            loginSession.session_id &&
            loginSession.session_id === sessionKey)
        let oauth
        let oauthFromVm = false
        if (looksLikeOfficialSetupToken(code)) {
          oauth = await completeClaudeSetupToken({
            projectRoot: cfg.paths.project,
            vmId: id,
            sessionId: sessionKey,
            code,
          })
        } else if (officialLogin) {
          oauth = await completeClaudeAuthLogin({
            projectRoot: cfg.paths.project,
            vmId: id,
            sessionId: sessionKey,
            code,
          })
        } else {
          oauthFromVm = true
          oauth = await exchangeAuthCode({
            exec: slotExec(cfg.paths.project, existing),
            projectRoot: cfg.paths.project,
            routing: routingConfig,
            sessionId: sessionKey,
            code,
            vmId: id,
          })
        }
        if (looksLikeOfficialSetupToken(code) || oauth.flavor === setupTokenFlavor) {
          oauth.type = 'official-setup-token'
          oauth.mode = 'official-setup-token'
        } else if (oauth.flavor === authLoginFlavor || oauth.source === authLoginSource) {
          oauth.type = 'oauth'
          oauth.mode = 'oauth'
        } else if (
          normalizeOauthFlavor(flavor) === 'setup_token' ||
          oauth.flavor === 'setup_token' ||
          oauth.flavor === 'setup-token'
        ) {
          oauth.type = 'setup-token'
          oauth.mode = 'setup-token'
        }
        if (body.auth_scheme || body.authScheme) oauth.auth_scheme = body.auth_scheme || body.authScheme
        if (oauth.access_token && !oauthFromVm)
          oauth = await enrichOauthIdentity(oauth, { proxyUrl: slotProxy.proxyUrl })
        await assertVendorRuntimeVm(req, id)
        const committed = await commitImportedOauth({
          vmId: id,
          vmPath,
          existing,
          oauth,
          source: oauth.source || 'oauth-auth-url',
          name: body.name,
        })
        if (!committed.ok) return respond(res, committed.status || 502, { ok: false, error: committed.error })
        return respond(
          res,
          200,
          panel.ok({
            vm: await summarizeVm(existing, cfg.paths.project, routingConfig),
            proxy_used: !!slotProxy.proxyUrl,
            oauth_email: existing.claude?.email,
            has_refresh: existing.claude?.has_refresh,
            official_cc_bootstrap: committed.official_cc_bootstrap || null,
            source: oauth.source || 'oauth-auth-url',
            flavor: oauth.flavor || null,
          }),
        )
      } catch (error) {
        const status =
          error.code === 'session_expired' || error.code === 'session_vm_mismatch' || error.code === 'code_required'
            ? 400
            : 502
        return respond(res, status, {
          ok: false,
          error: { code: error.code || 'exchange_code_failed', message: String(error.message || error).slice(0, 240) },
        })
      }
    }

    const credential = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/credential$/)
    if (credential && req.method === 'PUT') {
      const id = credential[1]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.id = existing.id || id
      const body = await readBody(req, 256 * 1024)
      const oauth = parseCredentialEdit(body)
      if (!oauth?.access_token && !oauth?.refresh_token && !oauth?.api_key)
        return respond(res, 400, {
          ok: false,
          error: { code: 'credential_required', message: 'sub2api JSON 需要 access_token、refresh_token 或 api_key' },
        })
      const committed = await commitImportedOauth({
        vmId: id,
        vmPath,
        existing,
        oauth,
        source: oauth.source || 'sub2api-account-export',
        skipOfficialCc: true,
      })
      if (!committed.ok) return respond(res, committed.status || 502, { ok: false, error: committed.error })
      try {
        invalidateLiveCredentialCache()
      } catch {}
      return respond(
        res,
        200,
        panel.ok({
          vm: await summarizeVm(existing, cfg.paths.project, routingConfig),
          oauth_email: existing.claude?.email || null,
          has_refresh: existing.claude?.has_refresh,
          official_cc_bootstrap: committed.official_cc_bootstrap || null,
        }),
      )
    }

    const convert = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/to-setup-token$/)
    if (convert && req.method === 'POST') {
      const id = convert[1]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      const existing = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
      existing.id = existing.id || id
      if (isCodexVm(existing))
        return respond(res, 409, {
          ok: false,
          error: { code: 'credential_kind_mismatch', message: 'Codex 槽不能转为 Claude Setup Token' },
        })
      const cred = readWorkerCredentialFile(path.join(cfg.paths.project, 'vms', id, 'cli-home'))
      if (isApiKeyMode(existing.claude?.mode) || isApiKeyMode(cred?.type || cred?.mode))
        return respond(res, 400, {
          ok: false,
          error: { code: 'credential_kind_mismatch', message: 'Console API Key 不能转为 Setup Token' },
        })
      if (isOfficialSetupTokenMode(existing.claude?.mode) || isOfficialSetupTokenMode(cred?.type || cred?.mode))
        return respond(res, 400, {
          ok: false,
          error: {
            code: 'credential_kind_mismatch',
            message: '官方 Setup Token 只有 inference，不能转为完整 Setup Token',
          },
        })
      if (isSetupTokenMode(existing.claude?.mode) || isSetupTokenMode(cred?.type || cred?.mode))
        return respond(
          res,
          200,
          panel.ok({
            vm: await summarizeVm(existing, cfg.paths.project, routingConfig),
            oauth_email: existing.claude?.email || null,
            has_refresh: existing.claude?.has_refresh,
            official_cc_bootstrap: { scheduled: false, reason: 'already_setup_token' },
          }),
        )
      let oauth
      try {
        oauth = liveOauthToSetupToken(cred || {})
      } catch (error) {
        return respond(res, 400, {
          ok: false,
          error: { code: error.code || 'credential_required', message: String(error.message || error).slice(0, 240) },
        })
      }
      const committed = await commitImportedOauth({
        vmId: id,
        vmPath,
        existing,
        oauth,
        source: 'oauth-to-setup-token',
        skipOfficialCc: true,
      })
      if (!committed.ok) return respond(res, committed.status || 502, { ok: false, error: committed.error })
      try {
        invalidateLiveCredentialCache()
      } catch {}
      return respond(
        res,
        200,
        panel.ok({
          vm: await summarizeVm(existing, cfg.paths.project, routingConfig),
          oauth_email: existing.claude?.email || null,
          has_refresh: existing.claude?.has_refresh,
          official_cc_bootstrap: committed.official_cc_bootstrap || null,
        }),
      )
    }

    const refresh = route.match(/^\/api\/panel\/vms\/([^/]+)\/oauth\/refresh$/)
    if (refresh && req.method === 'POST') {
      const id = refresh[1]
      const vmPath = path.join(cfg.paths.project, 'vms', `${id}.json`)
      if (!fs.existsSync(vmPath))
        return respond(res, 404, { ok: false, error: { code: 'vm_not_found', message: 'VM not found' } })
      const vm = getVm(cfg.paths.project, id)
      if (isCodexVm(vm)) {
        const first = readCodexAccounts(cfg.paths.project, id)[0] || {}
        const refreshToken = String(first.refresh_token || '').trim()
        if (!refreshToken)
          return respond(res, 400, {
            ok: false,
            error: { code: 'credential_mode_unsupported', message: 'GPT 槽没有 refresh_token，请重新导入 OAuth' },
          })
        const tok = await refreshCodexAccessToken({ refreshToken, proxyUrl: hostProxyUrlForVm(vm) })
        if (!tok.ok)
          return respond(res, 502, {
            ok: false,
            error: { code: tok.error || 'refresh_failed', message: 'GPT OAuth 刷新失败，请重新导入' },
          })
        upsertCodexAccount(cfg.paths.project, id, {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          id_token: tok.id_token || first.id_token,
          expires_at: tok.expires_at || first.expires_at,
        })
        return respond(res, 200, panel.ok({ ok: true, refreshed: true, platform: 'openai' }))
      }
      const oauthState = oauthCredentialState(vm)
      if (oauthState.api_key)
        return respond(res, 400, {
          ok: false,
          error: { code: 'credential_mode_unsupported', message: 'Console API Key 不能刷新' },
        })
      if (oauthState.official_setup_token || (oauthState.setup_token && !vm?.claude?.has_refresh))
        return respond(res, 400, {
          ok: false,
          error: { code: 'credential_mode_unsupported', message: '官方 Setup Token（无 refresh）不能刷新' },
        })
      const data = await refreshWorkerCredentialForVm({
        vmId: id,
        vmPath,
        homeDir: path.join(cfg.paths.project, 'vms', id, 'cli-home'),
        vm,
        force: true,
      })
      if (!data.ok) return respond(res, 502, { ok: false, error: data.error, data })
      const profile = await refreshAccountProfile(cfg.paths.project, id)
      return respond(
        res,
        200,
        panel.ok({
          ...data,
          subscription_profile: { ok: profile.ok, reason: profile.reason, updated_at: profile.updated_at },
        }),
      )
    }
    return false
  }
}

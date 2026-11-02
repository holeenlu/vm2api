/** VM quota and reset command adapters. */
export function createPanelVmQuotaRoutes({ cfg, routingConfig, accountQuota, panel, json }) {
  return async function handlePanelVmQuotaRoutes(req, res, path) {
    const match = path.match(
      /^\/api\/panel\/vms\/([^/]+)\/(openai-quota\/(refresh|reset)|claude-reset\/(query|redeem))$/,
    )
    if (!match || req.method !== 'POST') return false
    const id = match[1]
    const action = match[2]
    let result
    if (action === 'openai-quota/refresh') result = await panel.buildOpenaiQuotaRefresh({ cfg, id, routingConfig })
    else if (action === 'openai-quota/reset') result = await panel.buildOpenaiQuotaReset({ cfg, id, routingConfig })
    else if (action === 'claude-reset/query') result = await panel.buildClaudeResetQuery({ cfg, id, accountQuota })
    else
      result = await panel.buildClaudeResetRedeem({
        cfg,
        id,
        accountQuota,
        idempotencyKey: req.headers['idempotency-key'],
      })
    if (result.status) {
      json(res, result.status, result.body)
      return true
    }
    json(res, 200, result)
    return true
  }
}

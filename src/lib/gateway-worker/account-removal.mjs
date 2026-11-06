/**
 * Gateway（Codex）账号永久删除在 Worker 实例上的执行（docs/RESOURCE_WORKBENCH.md 第 6 节）。
 *
 * 控制面先在一个事务里写墓碑（vendor_resources.deleted_at）、删凭据库记录与刷新租约、清分组与 OAuth 会话，
 * 再逐个绑定实例调用 Worker 删除账号；Worker 删掉或明确回答账号不存在后去掉该实例的绑定。
 * 删除失败（实例不可达、超时）时绑定留作待删除（drifted，error=pending_delete）：该实例在执行时排除此账号，
 * 心跳投影（GatewayWorkerService.removeDeletedAccount）在实例回来后补删，与归档的停用补偿同一机制。
 * 不支持删除的旧版 Worker（405）先停用并清空分组与代理，不再接单，凭据待 Worker 升级后由心跳补删。
 */

/** 只有 Worker 明确回答账号不存在才算已删（反代或路由的 404 不算，复核 G4）。 */
export function workerAccountGone(result) {
  return !!result?.ok || (result?.status === 404 && result?.data?.error?.code === 'account_not_found')
}

/**
 * 在一个实例上删除账号。ports：{ client, repo }（GatewayWorkerClient / GatewayWorkerRepo 或测试替身）。
 * 返回 { ok, deleted } 或 { ok:false, error }，失败时绑定已标记为待删除。
 */
export async function removeAccountFromInstance({ client, repo }, accountResourceId, binding, projectionRevision) {
  const instanceId = binding.gateway_instance_id
  const runtimeAccountId = binding.runtime_account_id
  let result
  try {
    result = await client.deleteAccount(instanceId, runtimeAccountId)
  } catch (error) {
    result = { ok: false, status: 502, data: { error: { code: 'gateway_worker_unavailable', message: error.message } } }
  }
  if (workerAccountGone(result)) {
    await repo.deleteAccountBinding(accountResourceId, instanceId)
    return { account_id: accountResourceId, instance_id: instanceId, ok: true, deleted: true }
  }
  const unsupported = result?.status === 405
  if (unsupported) {
    try {
      await client.patchAccount(instanceId, runtimeAccountId, {
        groups: [],
        enabled: false,
        paused: true,
        proxy_url: '',
        projection_revision: projectionRevision,
      })
    } catch {}
  }
  await repo.recordProjection({
    accountResourceId,
    instanceId,
    runtimeAccountId,
    projectionRevision,
    credentialRevision: Number(binding.credential_revision || 0),
    status: 'drifted',
    error: 'pending_delete',
  })
  return {
    account_id: accountResourceId,
    instance_id: instanceId,
    ok: false,
    status: result?.status || 502,
    error: unsupported ? 'gateway_delete_unsupported' : result?.data?.error?.code || 'gateway_worker_unavailable',
  }
}

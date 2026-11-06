import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { RelayBilling } from './relay-billing.mjs'
import { identityCanResource, panelIdentity } from './panel-acl.mjs'
import { relayError, audit, integer } from './relay-common.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { groupAcceptsPlatform, isVmBackendKind, validateVmGroups } from './vm-group-validation.mjs'
import { vmGroupType } from './key-scope-policy.mjs'
import { groupUsage, groupCapacity } from './group-metrics.mjs'
import { openAIRuntimeSnapshot } from '../pool/openai-account-runtime.mjs'
import { VendorPlatform } from '../vendor/vendor-platform.mjs'
import { syncVendorUserGroups } from '../vendor/vendor-admin.mjs'
import { GatewayAccountManagement } from '../gateway-worker/account-management.mjs'
import { GatewayWorkerService } from '../gateway-worker/gateway-execution.mjs'
import { vendorGroupPlatforms } from '../vendor/vendor-groups.mjs'
import { bumpGroupVersion, deleteGroupResources, insertGroupResource, walletLedgerOwner } from './repos/relay-repo.mjs'

const ROOTS = ['/groups', '/billing', '/subscriptions']
export function createRelayHandler(ctx) {
  return async function handleRelay(req, res, url) {
    const path = url.pathname.replace('/api/panel', '')
    const matchResource = path.match(/^\/(vms|api-endpoints)\/([^/]+)\/groups$/)
    const matchUser = path.match(/^\/users\/([^/]+)\/(groups|balance|balance-history)$/)
    if (
      !ROOTS.some((root) => path === root || path.startsWith(root + '/')) &&
      !matchResource &&
      !matchUser &&
      path !== '/vms/groups/batch'
    )
      return false
    const identity = panelIdentity(req)
    const role = identity.role
    const actor = identity.user || 'master'
    const admin = role === 'super_admin'
    const manager = role === 'admin'
    const staff = admin
    // 被授予资源能力的 admin：分组以完整视图查看（资源工作台选择分组），可改 VM 的分组归属；
    // 分组本身的增删改、成员与 API 资源分组仍只属于 super_admin
    const resourceReader = identityCanResource(identity, 'read')
    const resourceEditor = identityCanResource(identity, 'edit')
    const db = ctx.apiKeyStore?.db || getDb()
    const groups = new GroupsRepo(db)
    const billing = new RelayBilling(db)
    const users = new UsersRepo(db)
    const supplierPlatform = role === 'vendor' ? new VendorPlatform(db) : null
    const supplierIdentity = supplierPlatform ? await supplierPlatform.identity(req.panelUserId) : undefined
    let vendorGroupIds = null
    if (supplierIdentity) {
      vendorGroupIds = new Set()
      for (const p of ['anthropic', 'openai'])
        for (const g of await supplierPlatform.availableAccountGroups(supplierIdentity, p)) vendorGroupIds.add(g.id)
    }
    // Gateway 账号的分组成员改动后回写账号配置并推送投影（分组与资源管理重整 P1）
    let gatewayAccountManager = null
    const gatewayAccounts = () => {
      if (!gatewayAccountManager) {
        const service = ctx.gatewayWorker || new GatewayWorkerService()
        gatewayAccountManager = new GatewayAccountManagement({ repo: service.repo, service })
      }
      return gatewayAccountManager
    }
    const send = (status, data) => {
      ctx.json(res, status, { ok: true, data })
      return true
    }
    const need = (ok) => {
      if (!ok) throw relayError('forbidden', '当前权限无法执行此操作', 403)
    }
    const body = () => ctx.readBody(req, 128 * 1024)
    const userScope = async () =>
      manager
        ? {
            type: 'panel_users',
            userId: url.searchParams.get('user_id') || null,
            scopeRootId: await users.scopeRootId(req.panelUserId),
          }
        : admin
          ? url.searchParams.get('user_id') || null
          : req.panelUserId
    async function liveResources(id) {
      return (await groups.resources(id)).filter(
        (r) => r.resource_kind !== 'vm' || getVm(ctx.cfg.paths.project, r.resource_id),
      )
    }
    async function resource(kind, id, groupIds) {
      if (kind === 'vm') {
        const vm = getVm(ctx.cfg.paths.project, id)
        if (!vm) throw relayError('vm_not_found', 'VM 不存在', 404)
        await validateVmGroups(groups, vm, groupIds)
        return
      } else if (kind === 'api_endpoint') {
        if (!(await ctx.apiEndpointStore?.listRaw())?.some((ep) => ep.id === id))
          throw relayError('endpoint_not_found', 'API 资源不存在', 404)
      } else throw relayError('invalid_resource_kind', '资源类型不正确')
      for (const gid of groupIds) {
        const group = await groups.getById(gid)
        if (!group) throw relayError('group_not_found', '分组不存在', 404)
        if ((await liveResources(gid)).some((r) => r.resource_kind !== kind))
          throw relayError('group_backend_mismatch', '一个分组只能使用一种执行后端，请分别创建 VM 与 API 分组')
      }
    }
    // 分组用量按请求只查一次：缓存查询的 Promise，列表里并发生成多个分组视图时共用同一次查询
    // 整机 VM 汇总同样缓存 Promise（R6 复审 P2-2）：并发生成的各分组视图在同一轮里恢复，只判 `!fleet` 会各算一遍
    let usage, fleetReady, fleet, seats
    async function metrics(g, resources = []) {
      usage ||= groupUsage(db, role === 'user' ? req.panelUserId : null)
      const usageByGroup = await usage
      if (resourceReader) {
        fleetReady ||= (async () => {
          const accounts = (await ctx.accountQuota?.repo?.list?.()) || []
          const byVm = new Map(accounts.map((a) => [a.vm_id, a]))
          const vms = (await listVms(ctx.cfg.paths.project, ctx.routingConfig)).map((vm) => {
            const acc = byVm.get(vm.id)
            return acc && vm.platform !== 'openai' ? { ...vm, max_concurrency: ctx.accountQuota.limitFor(acc) } : vm
          })
          const live = { ...(ctx.poolScheduler?.seatSnapshot?.().seats || {}) }
          for (const vm of vms)
            if (vm.platform === 'openai') live[vm.id] = { inflight: openAIRuntimeSnapshot(vm.id).inFlight }
          fleet = vms
          seats = live
        })()
        await fleetReady
      }
      return {
        ...(role !== 'admin'
          ? {
              usage: usageByGroup.get(g.id) || {
                today_cost: 0,
                yesterday_cost: 0,
                total_cost: 0,
                requests: 0,
                timezone: 'Asia/Shanghai',
              },
            }
          : {}),
        ...(resourceReader ? { capacity: groupCapacity(resources, fleet, seats) } : {}),
      }
    }
    async function groupView(g, full = resourceReader) {
      if (full) {
        const resources = await liveResources(g.id)
        return {
          ...g,
          supported_platforms:
            g.status === 'active' && resources.every((r) => isVmBackendKind(r.resource_kind))
              ? vendorGroupPlatforms(g)
              : [],
          resources,
          ...(await metrics(g, resources)),
        }
      }
      if (role === 'vendor') {
        if (!vendorGroupIds.has(g.id)) return null
        return {
          id: g.id,
          name: g.name,
          description: g.description,
          platform: g.platform,
          status: g.status,
          models: g.models,
          supported_platforms: g.status === 'active' ? vendorGroupPlatforms(g) : [],
          rate_multiplier: g.rate_multiplier,
          rpm_limit: g.rpm_limit,
          subscription_type: g.subscription_type,
          daily_limit_usd: g.daily_limit_usd,
          weekly_limit_usd: g.weekly_limit_usd,
          monthly_limit_usd: g.monthly_limit_usd,
        }
      }
      let access
      try {
        access = await groups.access(await users.getById(req.panelUserId), g.id)
      } catch {
        return null
      }
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        platform: g.platform,
        status: g.status,
        models: g.models,
        rate_multiplier: access.rate,
        ...(await metrics(g)),
        rpm_limit: g.rpm_limit,
        rpm_override: (await groups.override(req.panelUserId, g.id))?.rpm_limit ?? null,
        subscription_type: g.subscription_type,
        daily_limit_usd: g.daily_limit_usd,
        weekly_limit_usd: g.weekly_limit_usd,
        monthly_limit_usd: g.monthly_limit_usd,
      }
    }
    try {
      if (path === '/groups' && req.method === 'GET' && url.searchParams.has('available_to')) {
        need(admin)
        const owner = await users.getById(url.searchParams.get('available_to'))
        if (!owner) throw relayError('user_not_found', '用户不存在', 404)
        const items = []
        for (const g of await groups.list()) {
          try {
            const access = await groups.access(owner, g.id)
            items.push({ id: g.id, name: g.name, rate_multiplier: access.rate, platform: g.platform })
          } catch {}
        }
        return send(200, { items })
      }
      if (path === '/groups' && req.method === 'GET')
        return send(200, {
          items: (await Promise.all((await groups.list()).map((g) => groupView(g)))).filter(Boolean),
        })
      if (path === '/groups' && req.method === 'POST') {
        need(admin)
        return send(201, { item: await groups.create(await body(), actor) })
      }
      const overrideMatch = path.match(/^\/groups\/(\d+)\/user-overrides(?:\/([^/]+))?$/)
      if (overrideMatch) {
        need(admin)
        const groupId = Number(overrideMatch[1])
        if (!(await groups.getById(groupId))) throw relayError('group_not_found', '分组不存在', 404)
        if (!overrideMatch[2] && req.method === 'GET') return send(200, { items: await groups.overrides(groupId) })
        if (overrideMatch[2] && req.method === 'PATCH') {
          const input = await body()
          return send(200, {
            item: await groups.setOverride(decodeURIComponent(overrideMatch[2]), groupId, input, actor),
          })
        }
      }
      const groupMatch = path.match(/^\/groups\/(\d+)(?:\/(resources|duplicate))?$/)
      if (groupMatch) {
        const id = Number(groupMatch[1])
        const group = await groups.getById(id)
        if (!group) throw relayError('group_not_found', '分组不存在', 404)
        if (!groupMatch[2] && req.method === 'GET') {
          const item = await groupView(group)
          need(!!item)
          return send(200, { item })
        }
        if (!groupMatch[2] && req.method === 'PATCH') {
          need(admin)
          const input = await body()
          // 改平台：现有成员都要被新平台接纳（VM 按自身平台，Gateway 账号只服务 OpenAI）
          if (input.platform && input.platform !== group.platform)
            for (const r of await groups.resources(id)) {
              if (r.resource_kind === 'vm') {
                const vm = getVm(ctx.cfg.paths.project, r.resource_id)
                if (vm && !groupAcceptsPlatform(input.platform, vmGroupType(vm)))
                  throw relayError('group_platform_mismatch', '现有 VM 不支持目标平台')
              } else if (
                r.resource_kind === 'gateway_worker_account' &&
                !groupAcceptsPlatform(input.platform, 'openai')
              )
                throw relayError('group_platform_mismatch', '分组里有 Codex 账号，只能是 GPT 或混合平台')
            }
          return send(200, { item: await groups.update(id, input, actor) })
        }
        if (!groupMatch[2] && req.method === 'DELETE') {
          need(admin)
          // Gateway 账号的分组只存在 group_resources（迁移 128），删除分组即从账号上去掉
          await groups.remove(id, actor)
          return send(200, { deleted: id })
        }
        if (groupMatch[2] === 'duplicate' && req.method === 'POST') {
          need(admin)
          const input = await body()
          const item = await dbClient(db).tx(async () => {
            const copy = await groups.create({ ...group, name: input.name, models: group.models }, actor)
            if (input.copy_resources === true)
              for (const r of await liveResources(id)) {
                await insertGroupResource(db, copy.id, r.resource_kind, r.resource_id, r.priority)
                await groups.touchResource(r.resource_kind, r.resource_id)
              }
            return copy
          })
          // 复制出来的 Gateway 账号成员只写 group_resources，Worker 直读即生效
          return send(201, { item })
        }
        if (groupMatch[2] === 'resources' && req.method === 'PUT') {
          need(staff)
          const input = await body()
          if (!Array.isArray(input.resources)) throw relayError('invalid_resources', '资源必须是数组')
          // 先核对版本：过期的提交（例如期间删除了其中的 VM）回 409 让面板刷新，而不是按旧列表报资源不存在
          if (Number(input.expected_version) !== group.version)
            throw relayError('version_conflict', '分组已变化，请刷新', 409)
          // 一次提交分组的全部成员（VM、API 端点与 Gateway 账号），按目标状态校验：
          // 账号池（VM、Gateway 账号）与 API 端点不能混用，可以一次保存完成切换（分组与资源管理重整 P1）
          const items = input.resources.map((r) => ({
            resource_kind: String(r?.resource_kind || ''),
            resource_id: String(r?.resource_id || ''),
            priority: r?.priority,
          }))
          if (new Set(items.map((r) => r.resource_kind + ':' + r.resource_id)).size !== items.length)
            throw relayError('duplicate_resource', '资源不能重复')
          if (
            items.some((r) => r.resource_kind === 'api_endpoint') &&
            items.some((r) => r.resource_kind !== 'api_endpoint')
          )
            throw relayError(
              'group_backend_mismatch',
              '一个分组只能使用一种执行后端：账号池（VM、Codex 账号）或 API 端点',
            )
          const codexAccounts = items.some((r) => r.resource_kind === 'gateway_worker_account')
            ? new Map((await gatewayAccounts().repo.listCodexAccounts({ includeArchived: true })).map((a) => [a.id, a]))
            : new Map()
          for (const r of items) {
            if (r.resource_kind === 'vm') {
              const vm = getVm(ctx.cfg.paths.project, r.resource_id)
              if (!vm) throw relayError('vm_not_found', 'VM 不存在', 404)
              if (!groupAcceptsPlatform(group.platform, vmGroupType(vm)))
                throw relayError('group_platform_mismatch', `VM ${r.resource_id} 与分组平台不兼容`)
            } else if (r.resource_kind === 'api_endpoint') {
              if (!(await ctx.apiEndpointStore?.listRaw())?.some((ep) => ep.id === r.resource_id))
                throw relayError('endpoint_not_found', 'API 资源不存在', 404)
            } else if (r.resource_kind === 'gateway_worker_account') {
              const account = codexAccounts.get(r.resource_id)
              if (!account || account.status === 'archived')
                throw relayError('account_not_found', `Codex 账号 ${r.resource_id} 不存在或已归档`, 404)
            } else throw relayError('invalid_resource_kind', '资源类型不正确')
          }
          const before = await groups.resources(id)
          const gatewayBefore = new Set(
            before.filter((r) => r.resource_kind === 'gateway_worker_account').map((r) => r.resource_id),
          )
          const gatewayAfter = new Set(
            items.filter((r) => r.resource_kind === 'gateway_worker_account').map((r) => r.resource_id),
          )
          // 新加入的 Gateway 账号要在它的归属范围内（分组启用、支持 OpenAI，供应商账号还要在供应商授权的分组里）；
          // 已在本组的账号可以保留
          for (const accountId of gatewayAfter) {
            if (gatewayBefore.has(accountId)) continue
            const allowed = await gatewayAccounts().groupScope(codexAccounts.get(accountId))
            if (!allowed?.(group))
              throw relayError(
                'group_scope_forbidden',
                `Codex 账号 ${accountId} 不能加入该分组（分组已停用、不支持 OpenAI，或不在供应商授权范围内）`,
                403,
              )
          }
          // 分组视图含异步读取的用量，在事务提交后生成（事务内只做写入与校验）
          const updated = await dbClient(db).tx(async () => {
            const current = await groups.getById(id)
            if (!current) throw relayError('group_not_found', '分组不存在', 404)
            if (Number(input.expected_version) !== current.version)
              throw relayError('version_conflict', '分组已变化，请刷新', 409)
            for (const r of [...before, ...items]) await groups.touchResource(r.resource_kind, r.resource_id)
            await deleteGroupResources(db, id)
            for (const r of items)
              await insertGroupResource(
                db,
                id,
                r.resource_kind,
                r.resource_id,
                r.resource_kind === 'vm' ? integer(r.priority ?? 50, 0, 10000, 'priority') : 50,
              )
            // 竞态 R18：按读到的版本条件递增，并发修改过的分组回滚并返回 version_conflict
            if ((await bumpGroupVersion(db, new Date().toISOString(), id, current.version)).changes !== 1)
              throw relayError('version_conflict', '分组已变化，请刷新', 409)
            await audit(db, actor, 'group.resources', id, before, items, input.reason || '')
            return groups.getById(id)
          })
          return send(200, { item: await groupView(updated) })
        }
      }
      if (matchResource && req.method === 'PUT') {
        const kind = matchResource[1] === 'vms' ? 'vm' : 'api_endpoint'
        need(kind === 'vm' ? resourceEditor : staff)
        const id = decodeURIComponent(matchResource[2])
        const input = await body()
        if (!Array.isArray(input.group_ids)) throw relayError('invalid_group_ids', '分组必须为数组')
        await resource(kind, id, input.group_ids)
        return send(200, await groups.assignResource(kind, id, input.group_ids, input.expected_version, actor))
      }
      if (path === '/vms/groups/batch' && req.method === 'POST') {
        need(resourceEditor)
        const input = await body()
        if (
          !['add', 'remove', 'replace'].includes(input.operation) ||
          !Array.isArray(input.items) ||
          !Array.isArray(input.group_ids) ||
          input.items.length > 500
        )
          throw relayError('invalid_batch', '批量操作参数不正确')
        const items = await dbClient(db).tx(async () => {
          const out = []
          for (const item of input.items) {
            const before = (await groups.forResource('vm', item.id)).map((g) => g.id)
            const ids =
              input.operation === 'replace'
                ? input.group_ids
                : input.operation === 'add'
                  ? [...new Set([...before, ...input.group_ids])]
                  : before.filter((id) => !input.group_ids.includes(id))
            await resource('vm', item.id, ids)
            out.push({
              id: item.id,
              ...(await groups.assignResource('vm', item.id, ids, item.expected_version, actor)),
            })
          }
          return out
        })
        return send(200, { items })
      }
      if (matchUser) {
        need(admin || manager)
        const id = decodeURIComponent(matchUser[1])
        if (manager && !(await users.isInScope(id, req.panelUserId)))
          throw relayError('user_not_found', '用户不存在', 404)
        if (matchUser[2] === 'groups' && req.method === 'GET') return send(200, { items: await groups.grants(id) })
        if (matchUser[2] === 'groups' && req.method === 'PUT') {
          const input = await body()
          if (manager) {
            need((await users.getById(id))?.role === 'user')
            const allowed = new Set((await groups.grants(req.panelUserId)).map((g) => g.group_id))
            need(
              Array.isArray(input.groups) &&
                input.groups.every((g) => allowed.has(typeof g === 'number' ? g : g?.group_id)),
            )
          }
          const items = await dbClient(db).tx(async () => {
            const grants = await groups.setGrants(id, input.groups, actor)
            if ((await users.getById(id))?.role === 'vendor')
              await syncVendorUserGroups(new VendorPlatform(db), id, grants, actor)
            return grants
          })
          return send(200, { items })
        }
        if (matchUser[2] === 'balance' && req.method === 'POST') {
          need(await users.canFund(id, { actorId: req.panelUserId, role }))
          const input = await body()
          if (manager) {
            const operation = input.operation || 'add'
            need(operation === 'add' || operation === 'subtract')
            return send(
              200,
              operation === 'subtract'
                ? await billing.transfer(id, req.panelUserId, input, actor, { reclaim: true })
                : await billing.transfer(req.panelUserId, id, input, actor),
            )
          }
          return send(200, await billing.adjust(id, input, actor))
        }
        if (matchUser[2] === 'balance-history' && req.method === 'GET')
          return send(200, { ...(await billing.balance(id)), items: await billing.ledger(id) })
      }
      if (path === '/billing' && req.method === 'GET') {
        need(admin || manager || role === 'user')
        const id = await userScope()
        if (manager) {
          const target = url.searchParams.get('user_id') || null
          if (target && !(await users.isInScope(target, req.panelUserId)))
            throw relayError('forbidden', '只能查看管理范围内的用户账务', 403)
          const summary = await billing.balance(target || req.panelUserId)
          return send(200, {
            ...summary,
            self: await billing.balance(req.panelUserId),
            items: (
              await billing.ledger(id, {
                limit: url.searchParams.get('limit'),
                before: url.searchParams.get('before'),
                before_id: url.searchParams.get('before_id'),
              })
            ).map(({ metadata_json, actor, ...row }) => row),
            subscriptions: await billing.subscriptions(id),
          })
        }
        const summary = id ? await billing.balance(id) : {}
        const items = await billing.ledger(id, {
          limit: url.searchParams.get('limit'),
          before: url.searchParams.get('before'),
          before_id: url.searchParams.get('before_id'),
        })
        const rows = []
        if (admin)
          for (const r of items)
            rows.push({
              ...r,
              can_reverse:
                !['reversal', 'transfer', 'usage'].includes(r.kind) &&
                (await users.canFund(r.user_id, { actorId: req.panelUserId, role })),
            })
        return send(200, {
          ...summary,
          items: admin ? rows : items.map(({ metadata_json, actor, ...r }) => r),
          subscriptions: await billing.subscriptions(id),
        })
      }
      const reversal = path.match(/^\/billing\/ledger\/([^/]+)\/reverse$/)
      if (reversal && req.method === 'POST') {
        need(admin)
        const transaction = await walletLedgerOwner(db, decodeURIComponent(reversal[1]))
        need(transaction && (await users.canFund(transaction.user_id, { actorId: req.panelUserId, role })))
        const input = await body()
        return send(200, await billing.reverse(decodeURIComponent(reversal[1]), input, actor))
      }
      if (path === '/subscriptions' && req.method === 'GET') {
        need(admin || role === 'user')
        return send(200, { items: await billing.subscriptions(await userScope()) })
      }
      if (path === '/subscriptions' && req.method === 'POST') {
        need(admin)
        const input = await body()
        return send(201, { item: await billing.createSubscription(input, actor) })
      }
      const sub = path.match(/^\/subscriptions\/([^/]+)$/)
      if (sub && req.method === 'PATCH') {
        need(admin)
        const input = await body()
        return send(200, { item: await billing.updateSubscription(sub[1], input.status, actor) })
      }
      throw relayError('not_found', '接口不存在', 404)
    } catch (error) {
      ctx.json(res, error.status || (String(error.message).includes('UNIQUE') ? 409 : 400), {
        ok: false,
        error: { code: error.code || 'invalid_request', message: error.message },
      })
      return true
    }
  }
}

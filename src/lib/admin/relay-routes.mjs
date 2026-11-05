import { getDb, withTransaction } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { RelayBilling } from './relay-billing.mjs'
import { identityCanResource, panelIdentity } from './panel-acl.mjs'
import { relayError, audit, integer } from './relay-common.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isVmBackendKind, validateVmGroups } from './vm-group-validation.mjs'
import { vmGroupType } from './key-scope-policy.mjs'
import { groupUsage, groupCapacity } from './group-metrics.mjs'
import { openAIRuntimeSnapshot } from '../pool/openai-account-runtime.mjs'
import { VendorPlatform } from '../vendor/vendor-platform.mjs'
import { syncVendorUserGroups } from '../vendor/vendor-admin.mjs'
import { vendorGroupPlatforms } from '../vendor/vendor-groups.mjs'
import {
  bumpGroupVersion,
  deleteNonGatewayGroupResources,
  insertGroupResource,
  walletLedgerOwner,
} from './repos/relay-repo.mjs'

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
    const send = (status, data) => {
      ctx.json(res, status, { ok: true, data })
      return true
    }
    const need = (ok) => {
      if (!ok) throw relayError('forbidden', '当前权限无法执行此操作', 403)
    }
    const body = () => ctx.readBody(req, 128 * 1024)
    const userScope = () =>
      manager
        ? {
            type: 'panel_users',
            userId: url.searchParams.get('user_id') || null,
            scopeRootId: users.scopeRootId(req.panelUserId),
          }
        : admin
          ? url.searchParams.get('user_id') || null
          : req.panelUserId
    function liveResources(id) {
      return groups.resources(id).filter((r) => r.resource_kind !== 'vm' || getVm(ctx.cfg.paths.project, r.resource_id))
    }
    function resource(kind, id, groupIds) {
      if (kind === 'vm') {
        const vm = getVm(ctx.cfg.paths.project, id)
        if (!vm) throw relayError('vm_not_found', 'VM 不存在', 404)
        validateVmGroups(groups, vm, groupIds)
        return
      } else if (kind === 'api_endpoint') {
        if (!ctx.apiEndpointStore?.listRaw().some((ep) => ep.id === id))
          throw relayError('endpoint_not_found', 'API 资源不存在', 404)
      } else throw relayError('invalid_resource_kind', '资源类型不正确')
      for (const gid of groupIds) {
        const group = groups.getById(gid)
        if (!group) throw relayError('group_not_found', '分组不存在', 404)
        if (liveResources(gid).some((r) => r.resource_kind !== kind))
          throw relayError('group_backend_mismatch', '一个分组只能使用一种执行后端，请分别创建 VM 与 API 分组')
      }
    }
    // 分组用量按请求只查一次：缓存查询的 Promise，列表里并发生成多个分组视图时共用同一次查询
    let usage, fleet, seats
    async function metrics(g, resources = []) {
      usage ||= groupUsage(db, role === 'user' ? req.panelUserId : null)
      const usageByGroup = await usage
      if (resourceReader) {
        if (!fleet) {
          const accounts = ctx.accountQuota?.repo?.list?.() || []
          const byVm = new Map(accounts.map((a) => [a.vm_id, a]))
          fleet = listVms(ctx.cfg.paths.project, ctx.routingConfig).map((vm) => {
            const acc = byVm.get(vm.id)
            return acc && vm.platform !== 'openai' ? { ...vm, max_concurrency: ctx.accountQuota.limitFor(acc) } : vm
          })
          seats = { ...(ctx.poolScheduler?.seatSnapshot?.().seats || {}) }
          for (const vm of fleet)
            if (vm.platform === 'openai') seats[vm.id] = { inflight: openAIRuntimeSnapshot(vm.id).inFlight }
        }
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
        const resources = liveResources(g.id)
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
        access = groups.access(users.getById(req.panelUserId), g.id)
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
        rpm_override: groups.override(req.panelUserId, g.id)?.rpm_limit ?? null,
        subscription_type: g.subscription_type,
        daily_limit_usd: g.daily_limit_usd,
        weekly_limit_usd: g.weekly_limit_usd,
        monthly_limit_usd: g.monthly_limit_usd,
      }
    }
    try {
      if (path === '/groups' && req.method === 'GET' && url.searchParams.has('available_to')) {
        need(admin)
        const owner = users.getById(url.searchParams.get('available_to'))
        if (!owner) throw relayError('user_not_found', '用户不存在', 404)
        return send(200, {
          items: groups.list().flatMap((g) => {
            try {
              const access = groups.access(owner, g.id)
              return [{ id: g.id, name: g.name, rate_multiplier: access.rate, platform: g.platform }]
            } catch {
              return []
            }
          }),
        })
      }
      if (path === '/groups' && req.method === 'GET')
        return send(200, {
          items: (await Promise.all(groups.list().map((g) => groupView(g)))).filter(Boolean),
        })
      if (path === '/groups' && req.method === 'POST') {
        need(admin)
        return send(201, { item: groups.create(await body(), actor) })
      }
      const overrideMatch = path.match(/^\/groups\/(\d+)\/user-overrides(?:\/([^/]+))?$/)
      if (overrideMatch) {
        need(admin)
        const groupId = Number(overrideMatch[1])
        if (!groups.getById(groupId)) throw relayError('group_not_found', '分组不存在', 404)
        if (!overrideMatch[2] && req.method === 'GET') return send(200, { items: groups.overrides(groupId) })
        if (overrideMatch[2] && req.method === 'PATCH')
          return send(200, {
            item: groups.setOverride(decodeURIComponent(overrideMatch[2]), groupId, await body(), actor),
          })
      }
      const groupMatch = path.match(/^\/groups\/(\d+)(?:\/(resources|duplicate))?$/)
      if (groupMatch) {
        const id = Number(groupMatch[1])
        const group = groups.getById(id)
        if (!group) throw relayError('group_not_found', '分组不存在', 404)
        if (!groupMatch[2] && req.method === 'GET') {
          const item = await groupView(group)
          need(!!item)
          return send(200, { item })
        }
        if (!groupMatch[2] && req.method === 'PATCH') {
          need(admin)
          const input = await body()
          if (input.platform && input.platform !== group.platform)
            for (const r of groups.resources(id))
              if (r.resource_kind === 'vm') {
                const vm = getVm(ctx.cfg.paths.project, r.resource_id)
                if (vm && input.platform !== 'mixed' && input.platform !== vmGroupType(vm))
                  throw relayError('group_platform_mismatch', '现有 VM 不支持目标平台')
              }
          return send(200, { item: groups.update(id, input, actor) })
        }
        if (!groupMatch[2] && req.method === 'DELETE') {
          need(admin)
          groups.remove(id, actor)
          return send(200, { deleted: id })
        }
        if (groupMatch[2] === 'duplicate' && req.method === 'POST') {
          need(admin)
          const input = await body()
          const item = withTransaction(db, () => {
            const copy = groups.create({ ...group, name: input.name, models: group.models }, actor)
            if (input.copy_resources === true)
              for (const r of liveResources(id)) {
                insertGroupResource(db, copy.id, r.resource_kind, r.resource_id, r.priority)
                groups.touchResource(r.resource_kind, r.resource_id)
              }
            return copy
          })
          return send(201, { item })
        }
        if (groupMatch[2] === 'resources' && req.method === 'PUT') {
          need(staff)
          const input = await body()
          if (!Array.isArray(input.resources)) throw relayError('invalid_resources', '资源必须是数组')
          // 分组视图含异步读取的用量，在事务提交后生成（事务内只做写入与校验）
          const updated = withTransaction(db, () => {
            const current = groups.getById(id)
            if (!current) throw relayError('group_not_found', '分组不存在', 404)
            if (Number(input.expected_version) !== current.version)
              throw relayError('version_conflict', '分组已变化，请刷新', 409)
            if (
              new Set(input.resources.map((r) => r.resource_kind + ':' + r.resource_id)).size !== input.resources.length
            )
              throw relayError('duplicate_resource', '资源不能重复')
            if (new Set(input.resources.map((r) => r.resource_kind)).size > 1)
              throw relayError('group_backend_mismatch', '分组不能混用 VM 和 API 执行后端')
            for (const r of input.resources) resource(r.resource_kind, r.resource_id, [id])
            // Gateway Worker accounts are bound from the account page; this list only replaces VMs / API endpoints.
            const before = groups.resources(id).filter((r) => r.resource_kind !== 'gateway_worker_account')
            for (const r of [...before, ...input.resources]) groups.touchResource(r.resource_kind, r.resource_id)
            deleteNonGatewayGroupResources(db, id)
            for (const r of input.resources)
              insertGroupResource(
                db,
                id,
                r.resource_kind,
                r.resource_id,
                integer(r.priority ?? 50, 0, 10000, 'priority'),
              )
            bumpGroupVersion(db, new Date().toISOString(), id)
            audit(db, actor, 'group.resources', id, before, input.resources, input.reason || '')
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
        resource(kind, id, input.group_ids)
        return send(200, groups.assignResource(kind, id, input.group_ids, input.expected_version, actor))
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
        const items = withTransaction(db, () =>
          input.items.map((item) => {
            const before = groups.forResource('vm', item.id).map((g) => g.id)
            const ids =
              input.operation === 'replace'
                ? input.group_ids
                : input.operation === 'add'
                  ? [...new Set([...before, ...input.group_ids])]
                  : before.filter((id) => !input.group_ids.includes(id))
            resource('vm', item.id, ids)
            return { id: item.id, ...groups.assignResource('vm', item.id, ids, item.expected_version, actor) }
          }),
        )
        return send(200, { items })
      }
      if (matchUser) {
        need(admin || manager)
        const id = decodeURIComponent(matchUser[1])
        if (manager && !users.isInScope(id, req.panelUserId)) throw relayError('user_not_found', '用户不存在', 404)
        if (matchUser[2] === 'groups' && req.method === 'GET') return send(200, { items: groups.grants(id) })
        if (matchUser[2] === 'groups' && req.method === 'PUT') {
          const input = await body()
          if (manager) {
            need(users.getById(id)?.role === 'user')
            const allowed = new Set(groups.grants(req.panelUserId).map((g) => g.group_id))
            need(
              Array.isArray(input.groups) &&
                input.groups.every((g) => allowed.has(typeof g === 'number' ? g : g?.group_id)),
            )
          }
          const items = await dbClient(db).tx(async () => {
            const grants = groups.setGrants(id, input.groups, actor)
            if (users.getById(id)?.role === 'vendor')
              await syncVendorUserGroups(new VendorPlatform(db), id, grants, actor)
            return grants
          })
          return send(200, { items })
        }
        if (matchUser[2] === 'balance' && req.method === 'POST') {
          need(users.canFund(id, { actorId: req.panelUserId, role }))
          const input = await body()
          if (manager) {
            const operation = input.operation || 'add'
            need(operation === 'add' || operation === 'subtract')
            return send(
              200,
              operation === 'subtract'
                ? billing.transfer(id, req.panelUserId, input, actor, { reclaim: true })
                : billing.transfer(req.panelUserId, id, input, actor),
            )
          }
          return send(200, billing.adjust(id, input, actor))
        }
        if (matchUser[2] === 'balance-history' && req.method === 'GET')
          return send(200, { ...billing.balance(id), items: billing.ledger(id) })
      }
      if (path === '/billing' && req.method === 'GET') {
        need(admin || manager || role === 'user')
        const id = userScope()
        if (manager) {
          const target = url.searchParams.get('user_id') || null
          if (target && !users.isInScope(target, req.panelUserId))
            throw relayError('forbidden', '只能查看管理范围内的用户账务', 403)
          const summary = billing.balance(target || req.panelUserId)
          return send(200, {
            ...summary,
            self: billing.balance(req.panelUserId),
            items: billing
              .ledger(id, {
                limit: url.searchParams.get('limit'),
                before: url.searchParams.get('before'),
                before_id: url.searchParams.get('before_id'),
              })
              .map(({ metadata_json, actor, ...row }) => row),
            subscriptions: billing.subscriptions(id),
          })
        }
        const summary = id ? billing.balance(id) : {}
        const items = billing.ledger(id, {
          limit: url.searchParams.get('limit'),
          before: url.searchParams.get('before'),
          before_id: url.searchParams.get('before_id'),
        })
        return send(200, {
          ...summary,
          items: admin
            ? items.map((r) => ({
                ...r,
                can_reverse:
                  !['reversal', 'transfer', 'usage'].includes(r.kind) &&
                  users.canFund(r.user_id, { actorId: req.panelUserId, role }),
              }))
            : items.map(({ metadata_json, actor, ...r }) => r),
          subscriptions: billing.subscriptions(id),
        })
      }
      const reversal = path.match(/^\/billing\/ledger\/([^/]+)\/reverse$/)
      if (reversal && req.method === 'POST') {
        need(admin)
        const transaction = walletLedgerOwner(db, decodeURIComponent(reversal[1]))
        need(transaction && users.canFund(transaction.user_id, { actorId: req.panelUserId, role }))
        return send(200, billing.reverse(decodeURIComponent(reversal[1]), await body(), actor))
      }
      if (path === '/subscriptions' && req.method === 'GET') {
        need(admin || role === 'user')
        return send(200, { items: billing.subscriptions(userScope()) })
      }
      if (path === '/subscriptions' && req.method === 'POST') {
        need(admin)
        return send(201, { item: billing.createSubscription(await body(), actor) })
      }
      const sub = path.match(/^\/subscriptions\/([^/]+)$/)
      if (sub && req.method === 'PATCH') {
        need(admin)
        return send(200, { item: billing.updateSubscription(sub[1], (await body()).status, actor) })
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

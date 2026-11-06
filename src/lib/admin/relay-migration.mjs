/** One-time, scope-preserving conversion. Old schema is retained only as migration evidence. */
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { vmGroupType } from './key-scope.mjs'
// 启动时执行一次的数据转换：整段在一个 async 事务里，迁移自身的 SQL 与分组仓储都经 DbClient（R6 B8，不再同步执行）
export async function migrateRelayScopes(db, vms = [], endpoints = []) {
  const name = 'commercial-scopes-v1'
  const client = dbClient(db)
  const done = await client.one('SELECT report_json FROM relay_migrations WHERE name=?', name)
  if (done) return JSON.parse(done.report_json)
  return client.tx(async (tx) => {
    const repo = new GroupsRepo(db)
    const report = {
      balances: (await tx.many('SELECT id,balance,balance_micros FROM users')).map((u) => ({
        user_id: u.id,
        source_balance: u.balance,
        balance_micros: u.balance_micros,
        rounding_difference: u.balance_micros / 1e6 - u.balance,
      })),
      keys: [],
      private_resources: [],
      unattributed_usage: (await tx.one('SELECT COUNT(*) n FROM usage_logs WHERE user_id IS NULL')).n,
    }
    for (const key of await tx.many('SELECT * FROM api_keys WHERE deleted_at IS NULL')) {
      const owner = key.user_id ? await tx.one('SELECT * FROM users WHERE id=?', key.user_id) : null
      const customer = owner?.role === 'user'
      let ids = []
      try {
        ids = JSON.parse(key.allowed_vms || '[]')
      } catch {}
      const pool = key.vm_pool_id ? await tx.one('SELECT * FROM vm_pools WHERE id=?', key.vm_pool_id) : null
      const allowed = key.vm_pool_id
        ? new Set(
            (await tx.many('SELECT vm_id FROM vm_pool_members WHERE pool_id=?', key.vm_pool_id)).map((r) => r.vm_id),
          )
        : null
      const resources =
        key.category === 'api'
          ? endpoints.map((e) => ({ resource_kind: 'api_endpoint', resource_id: e.id }))
          : vms
              .filter((vm) => (customer ? vm.owner_user_id === key.user_id : !vm.owner_user_id))
              .filter(
                (vm) =>
                  (!allowed || allowed.has(vm.id)) &&
                  (key.group_type === 'all' ||
                    !key.group_type ||
                    (vmGroupType(vm) === key.group_type && (allowed || ids.includes(vm.id)))),
              )
              .map((vm) => ({ resource_kind: 'vm', resource_id: vm.id }))
      const oldGroup = await repo.getById(key.group_id)
      const group = await repo.create(
        {
          name: '迁移-' + key.id,
          platform: key.group_type === 'all' || !key.group_type ? 'mixed' : key.group_type,
          rate_multiplier: oldGroup?.rate_multiplier ?? 1,
          is_exclusive: true,
          status: key.vm_pool_id && (!pool || !pool.enabled) ? 'inactive' : 'active',
        },
        'migration',
      )
      for (const r of resources)
        await tx.run(
          'INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(?,?,?)',
          group.id,
          r.resource_kind,
          r.resource_id,
        )
      if (key.user_id && owner)
        await tx.run(
          'INSERT OR IGNORE INTO user_groups(user_id,group_id,created_at) VALUES(?,?,?)',
          key.user_id,
          group.id,
          new Date().toISOString(),
        )
      await tx.run('UPDATE api_keys SET group_id=? WHERE id=?', group.id, key.id)
      report.keys.push({
        key_id: key.id,
        user_id: key.user_id,
        previous_group_id: key.group_id,
        group_id: group.id,
        previous_pool_id: key.vm_pool_id,
        resource_ids: resources.map((r) => r.resource_id),
      })
    }
    for (const vm of vms.filter((v) => v.owner_user_id))
      report.private_resources.push({
        vm_id: vm.id,
        previous_owner: vm.owner_user_id,
        origin: vm.origin || 'admin_assigned',
      })
    await tx.run(
      'INSERT INTO relay_migrations(name,report_json,applied_at) VALUES(?,?,?)',
      name,
      JSON.stringify(report),
      new Date().toISOString(),
    )
    return report
  })
}

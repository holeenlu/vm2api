/**
 * proxies repository — SOCKS5 pool rows + pool config in settings.
 * The ProxyPool keeps its working set in memory (probe loop mutates it);
 * this repo is the persistence surface: loadAll / replaceAll.
 * 行读写经 DbClient 异步访问（R6 B6c）；`replaceAllSync` 与异步版本共用 SQL，只供尚未改造的同步调用方使用，
 * 见 docs/data-access/R6_PROGRESS.md。
 */

import { getDb, withTransaction } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { SettingsRepo } from './settings-repo.mjs'

const CONFIG_KEY = 'proxy_pool_config'

const COLUMNS = [
  'id',
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'raw',
  'status',
  'enabled',
  'name',
  'label',
  'owner_user_id',
  'vendor_id',
  'vendor_resource_id',
  'platforms_json',
  'bound_vm_id',
  'consecutive_failures',
  'latency_ms',
  'last_probe_at',
  'last_error',
  'geo_ip',
  'geo_country',
  'geo_country_code',
  'geo_region',
  'geo_city',
  'geo_isp',
  'geo_timezone',
  'geo_checked_at',
  'geo_error',
  'geo_v6_ip',
  'geo_v6_country',
  'geo_v6_country_code',
  'geo_v6_region',
  'geo_v6_city',
  'geo_v6_isp',
  'geo_v6_timezone',
  'geo_v6_checked_at',
  'geo_v6_error',
  'created_at',
  'updated_at',
  'domain_forward',
  'quality_json',
  'quality_version',
  'expires_at',
  'fallback_mode',
  'backup_proxy_id',
  'max_websocket_connections',
  'request_location_mode',
  'location_country',
  'location_region',
  'location_city',
  'location_timezone',
]

function rowToProxy(row) {
  if (!row) return null
  // ProxyPool still speaks `scheme`; the column is sub2api's `protocol`.
  let platforms = []
  try {
    const parsed = JSON.parse(row.platforms_json || '[]')
    platforms = Array.isArray(parsed) ? parsed : []
  } catch {}
  return {
    ...row,
    scheme: row.protocol,
    platforms,
    enabled: !!row.enabled,
    domain_forward: !!row.domain_forward,
  }
}

const LOAD_ALL_SQL = 'SELECT * FROM proxies ORDER BY created_at, id'
const CLEAR_SQL = 'DELETE FROM proxies'
const INSERT_SQL = `
      INSERT INTO proxies (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `

function insertParams(p) {
  return COLUMNS.map((c) => {
    if (c === 'enabled') return p.enabled === false ? 0 : 1
    if (c === 'domain_forward') return p.domain_forward ? 1 : 0
    if (c === 'quality_version') return p.quality_version || 0
    if (c === 'fallback_mode') return p.fallback_mode || 'none'
    if (c === 'max_websocket_connections') return Math.max(0, Number(p.max_websocket_connections) || 0)
    if (c === 'request_location_mode') return p.request_location_mode || 'inherit'
    if (c === 'protocol') return p.protocol ?? p.scheme ?? 'socks5'
    if (c === 'platforms_json') return JSON.stringify(Array.isArray(p.platforms) ? p.platforms : [])
    if (c === 'name') return p.name ?? (p.host && p.port != null ? `${p.host}:${p.port}` : p.id)
    return p[c] ?? null
  })
}

export class ProxiesRepo {
  constructor(db = getDb()) {
    this.db = db
    this.settings = new SettingsRepo(db)
  }

  async loadAll() {
    return (await dbClient(this.db).many(LOAD_ALL_SQL)).map(rowToProxy)
  }

  async replaceAll(proxies = []) {
    await dbClient(this.db).tx(async (tx) => {
      await tx.run(CLEAR_SQL)
      for (const p of proxies) await tx.run(INSERT_SQL, ...insertParams(p))
    })
  }

  /** R6 临时同步出口（B7 删除）：ProxyPool.save 同步写回（推理热路径 reportRuntimeFailure 与代理池的同步方法）。 */
  replaceAllSync(proxies = []) {
    const client = dbClient(this.db)
    withTransaction(this.db, () => {
      client.runSync(CLEAR_SQL)
      for (const p of proxies) client.runSync(INSERT_SQL, ...insertParams(p))
    })
  }

  getConfig(fallback = null) {
    return this.settings.get(CONFIG_KEY, fallback)
  }

  /** R6 临时同步出口（B7 删除）：ProxyPool.save 与启动导入同步写代理池配置。 */
  setConfig(config) {
    return this.settings.setSync(CONFIG_KEY, config)
  }
}

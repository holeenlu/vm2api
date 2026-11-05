import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'

/*
 * API 端点仓储，经 DbClient 异步访问（R6 B6b）。`listHydratedSync` / `setKeyCooldownSync` 是临时同步出口，
 * 只供推理热路径（API 端点调度器重载与 Key 冷却，B7 删除）使用，与异步版本共用 SQL；见 docs/data-access/R6_PROGRESS.md。
 */

const EP_COLS = [
  'id',
  'name',
  'disabled',
  'prefix',
  'base_url',
  'headers_json',
  'disable_cooling',
  'priority',
  'kind',
  'protocol',
  'risk_review_enabled',
  'created_at',
  'updated_at',
]
const KEY_COLS = ['id', 'endpoint_id', 'api_key', 'proxy_url', 'proxy_id', 'disabled', 'cooldown_until', 'created_at']
const MODEL_COLS = ['id', 'endpoint_id', 'sort', 'upstream_name', 'alias', 'image', 'thinking_levels_json']

function bool01(v) {
  return v ? 1 : 0
}

function rowEp(row) {
  if (!row) return null
  let headers = {}
  try {
    headers = row.headers_json ? JSON.parse(row.headers_json) : {}
  } catch {
    headers = {}
  }
  return {
    id: row.id,
    name: row.name,
    disabled: !!row.disabled,
    prefix: row.prefix || '',
    base_url: row.base_url,
    headers,
    disable_cooling: !!row.disable_cooling,
    priority: Number(row.priority) || 0,
    kind: row.kind || 'custom',
    protocol: row.protocol || 'anthropic',
    risk_review_enabled: !!row.risk_review_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowKey(row) {
  if (!row) return null
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    api_key: row.api_key,
    proxy_url: row.proxy_url || '',
    proxy_id: row.proxy_id || '',
    disabled: !!row.disabled,
    cooldown_until: row.cooldown_until || null,
    created_at: row.created_at,
  }
}

function rowModel(row) {
  if (!row) return null
  let thinking_levels = null
  try {
    thinking_levels = row.thinking_levels_json ? JSON.parse(row.thinking_levels_json) : null
  } catch {
    thinking_levels = null
  }
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    sort: Number(row.sort) || 0,
    name: row.upstream_name,
    alias: row.alias,
    image: !!row.image,
    thinking: thinking_levels ? { levels: thinking_levels } : undefined,
  }
}

const LIST_EP_SQL = 'SELECT * FROM api_endpoints ORDER BY priority DESC, created_at, id'
const GET_EP_SQL = 'SELECT * FROM api_endpoints WHERE id = ?'
const INSERT_EP_SQL = `INSERT INTO api_endpoints (${EP_COLS.join(',')}) VALUES (${EP_COLS.map(() => '?').join(',')})`
const DELETE_EP_SQL = 'DELETE FROM api_endpoints WHERE id = ?'
const LIST_KEYS_SQL = 'SELECT * FROM api_endpoint_keys WHERE endpoint_id = ? ORDER BY created_at, id'
const GET_KEY_SQL = 'SELECT * FROM api_endpoint_keys WHERE id = ?'
const INSERT_KEY_SQL = `INSERT INTO api_endpoint_keys (${KEY_COLS.join(',')}) VALUES (${KEY_COLS.map(() => '?').join(',')})`
const DELETE_KEY_SQL = 'DELETE FROM api_endpoint_keys WHERE id = ?'
const DELETE_EP_KEYS_SQL = 'DELETE FROM api_endpoint_keys WHERE endpoint_id = ?'
const LIST_MODELS_SQL = 'SELECT * FROM api_endpoint_models WHERE endpoint_id = ? ORDER BY sort, id'
const INSERT_MODEL_SQL = `INSERT INTO api_endpoint_models (${MODEL_COLS.join(',')}) VALUES (${MODEL_COLS.map(() => '?').join(',')})`
const DELETE_EP_MODELS_SQL = 'DELETE FROM api_endpoint_models WHERE endpoint_id = ?'
const SET_COOLDOWN_SQL = 'UPDATE api_endpoint_keys SET cooldown_until = ? WHERE id = ?'
const UPDATE_KEY_SQL =
  'UPDATE api_endpoint_keys SET api_key = ?, proxy_url = ?, proxy_id = ?, disabled = ?, cooldown_until = ? WHERE id = ?'
const UPDATE_EP_COLS = EP_COLS.filter((c) => c !== 'id')
const UPDATE_EP_SQL = `UPDATE api_endpoints SET ${UPDATE_EP_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`

function hydrated(ep, keys, models) {
  if (!ep) return null
  return { ...ep, api_key_entries: keys.map(rowKey), models: models.map(rowModel) }
}

export class ApiEndpointsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  async listHydrated() {
    const out = []
    for (const row of await this.client.many(LIST_EP_SQL)) out.push(await this.hydrate(rowEp(row)))
    return out
  }

  /** R6 临时同步出口（B7 删除）：推理热路径 ApiEndpointStore.listRawSync（API 调度器重载）。 */
  listHydratedSync() {
    return this.client.manySync(LIST_EP_SQL).map((row) => this.hydrateSync(rowEp(row)))
  }

  async getHydrated(id) {
    return this.hydrate(rowEp(await this.client.one(GET_EP_SQL, id)))
  }

  async hydrate(ep) {
    if (!ep) return null
    return hydrated(ep, await this.client.many(LIST_KEYS_SQL, ep.id), await this.client.many(LIST_MODELS_SQL, ep.id))
  }

  /** R6 临时同步出口（B7 删除）：listHydratedSync 的逐行装配。 */
  hydrateSync(ep) {
    if (!ep) return null
    return hydrated(ep, this.client.manySync(LIST_KEYS_SQL, ep.id), this.client.manySync(LIST_MODELS_SQL, ep.id))
  }

  _epValues(rec) {
    return {
      id: rec.id,
      name: rec.name,
      disabled: bool01(rec.disabled),
      prefix: rec.prefix || '',
      base_url: rec.base_url,
      headers_json: JSON.stringify(rec.headers || {}),
      disable_cooling: bool01(rec.disable_cooling),
      priority: Number(rec.priority) || 0,
      kind: rec.kind || 'custom',
      protocol: rec.protocol || 'anthropic',
      risk_review_enabled: bool01(rec.risk_review_enabled),
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    }
  }

  async insertEndpoint(rec) {
    const vals = this._epValues(rec)
    await this.client.run(INSERT_EP_SQL, ...EP_COLS.map((c) => vals[c] ?? null))
    return this.getHydrated(rec.id)
  }

  async updateEndpoint(rec) {
    const vals = this._epValues(rec)
    await this.client.run(UPDATE_EP_SQL, ...UPDATE_EP_COLS.map((c) => vals[c] ?? null), rec.id)
    return this.getHydrated(rec.id)
  }

  async removeEndpoint(id) {
    return this.client.tx(async (tx) => {
      await tx.run(DELETE_EP_KEYS_SQL, id)
      await tx.run(DELETE_EP_MODELS_SQL, id)
      return (await tx.run(DELETE_EP_SQL, id)).changes > 0
    })
  }

  async insertKey(rec) {
    await this.client.run(
      INSERT_KEY_SQL,
      rec.id,
      rec.endpoint_id,
      rec.api_key,
      rec.proxy_url || '',
      rec.proxy_id || '',
      bool01(rec.disabled),
      rec.cooldown_until || null,
      rec.created_at,
    )
    return rowKey(await this.client.one(GET_KEY_SQL, rec.id))
  }

  async removeKey(id) {
    return (await this.client.run(DELETE_KEY_SQL, id)).changes > 0
  }

  async updateKey(id, patch = {}) {
    const rec = rowKey(await this.client.one(GET_KEY_SQL, id))
    if (!rec) return null
    if (patch.api_key != null) {
      const next = String(patch.api_key).trim()
      if (next.length >= 4) rec.api_key = next
    }
    if (patch.proxy_url != null) rec.proxy_url = String(patch.proxy_url).trim()
    if (patch.proxy_id != null) rec.proxy_id = String(patch.proxy_id).trim()
    if (patch.disabled != null) rec.disabled = !!patch.disabled
    if (patch.cooldown_until !== undefined) rec.cooldown_until = patch.cooldown_until || null
    await this.client.run(
      UPDATE_KEY_SQL,
      rec.api_key,
      rec.proxy_url || '',
      rec.proxy_id || '',
      bool01(rec.disabled),
      rec.cooldown_until,
      rec.id,
    )
  }

  async setKeyCooldown(id, untilIso) {
    await this.client.run(SET_COOLDOWN_SQL, untilIso, id)
  }

  /** R6 临时同步出口（B7 删除）：推理热路径 ApiEndpointStore.setKeyCooldownSync（上游 Key 限流冷却）。 */
  setKeyCooldownSync(id, untilIso) {
    this.client.runSync(SET_COOLDOWN_SQL, untilIso, id)
  }

  async replaceModels(endpointId, models = []) {
    await this.client.tx(async (tx) => {
      await tx.run(DELETE_EP_MODELS_SQL, endpointId)
      for (const [i, m] of models.entries()) {
        const levels = Array.isArray(m.thinking?.levels)
          ? m.thinking.levels
          : Array.isArray(m.thinking_levels)
            ? m.thinking_levels
            : null
        await tx.run(
          INSERT_MODEL_SQL,
          m.id,
          endpointId,
          Number(m.sort ?? i),
          m.name || m.upstream_name,
          m.alias || m.name,
          bool01(m.image),
          levels ? JSON.stringify(levels) : null,
        )
      }
    })
    return this.getHydrated(endpointId)
  }
}

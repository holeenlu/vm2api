/**
 * cluster_nodes repository — SSH-reachable VPS nodes.
 * Credentials are encrypted at rest via maybeEncrypt and never leave through
 * `list()` / `get()`; only `getSecrets()` returns them, for the connector.
 * 经 DbClient 异步访问（R6 B6c）；`platformSync` 与 `platform` 共用 SQL，只供推理热路径同步读取，
 * 见 docs/data-access/R6_PROGRESS.md。
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { maybeDecrypt, maybeEncrypt } from '../secure.mjs'

const PUBLIC_COLUMNS = [
  'id',
  'label',
  'host',
  'port',
  'username',
  'auth_type',
  'host_key_alg',
  'host_key_sha256',
  'jump_node_id',
  'created_at',
  'updated_at',
]

function nextUpdatedAt(expectedUpdatedAt) {
  const previousMs = Date.parse(expectedUpdatedAt)
  if (!Number.isFinite(previousMs)) return null
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString()
}

const LIST_SQL = `SELECT ${PUBLIC_COLUMNS.join(', ')} FROM cluster_nodes ORDER BY created_at, id`
const GET_SQL = `SELECT ${PUBLIC_COLUMNS.join(', ')} FROM cluster_nodes WHERE id = ?`
const SECRETS_SQL = 'SELECT password, private_key, passphrase FROM cluster_nodes WHERE id = ?'
const FIND_ENDPOINT_SQL = 'SELECT id FROM cluster_nodes WHERE host = ? AND port = ? AND username = ?'
const DEPENDENTS_SQL = 'SELECT id FROM cluster_nodes WHERE jump_node_id = ?'
const INSERT_SQL = `
      INSERT INTO cluster_nodes (id, label, host, port, username, auth_type, password, private_key, passphrase,
        host_key_alg, host_key_sha256, jump_node_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
const UPDATE_SQL = `
      UPDATE cluster_nodes SET label = ?, host = ?, port = ?, username = ?, auth_type = ?,
        password = ?, private_key = ?, passphrase = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
      RETURNING ${PUBLIC_COLUMNS.join(', ')}
    `
const UPDATE_LABEL_SQL = `
      UPDATE cluster_nodes SET label = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
      RETURNING ${PUBLIC_COLUMNS.join(', ')}
    `
const REMOVE_SQL = 'DELETE FROM cluster_nodes WHERE id = ?'
const PLATFORM_SQL = 'SELECT platform FROM cluster_nodes WHERE id = ?'
const SET_PLATFORM_SQL = 'UPDATE cluster_nodes SET platform = ? WHERE id = ?'
const DIRECT_LINKS_SQL = 'SELECT node_id, address, port FROM cluster_node_direct_links'
const GET_DIRECT_LINK_SQL = 'SELECT address, port, token, cert_sha256 FROM cluster_node_direct_links WHERE node_id = ?'
const SET_DIRECT_LINK_SQL = `
      INSERT INTO cluster_node_direct_links (node_id, address, port, token, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET address = excluded.address, port = excluded.port,
        token = excluded.token, updated_at = excluded.updated_at
    `
const SET_DIRECT_LINK_CERT_SQL = 'UPDATE cluster_node_direct_links SET cert_sha256 = ? WHERE node_id = ?'
const CLEAR_DIRECT_LINK_SQL = 'DELETE FROM cluster_node_direct_links WHERE node_id = ?'

// 语句由 DbClient 在首次使用时预编译：只加载到 026 的旧夹具不碰 platform 列与直连表就不会报错。
export class ClusterNodesRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  async list() {
    return (await dbClient(this.db).many(LIST_SQL)).map((row) => ({ ...row }))
  }

  async get(id) {
    const row = await dbClient(this.db).one(GET_SQL, id)
    return row ? { ...row } : null
  }

  async findByEndpoint(host, port, username) {
    return (await dbClient(this.db).one(FIND_ENDPOINT_SQL, host, port, username))?.id || null
  }

  async dependentsOf(id) {
    return (await dbClient(this.db).many(DEPENDENTS_SQL, id)).map((row) => row.id)
  }

  async getSecrets(id) {
    const row = await dbClient(this.db).one(SECRETS_SQL, id)
    if (!row) return null
    return {
      password: maybeDecrypt(row.password),
      privateKey: maybeDecrypt(row.private_key),
      passphrase: maybeDecrypt(row.passphrase),
    }
  }

  async insert(node, now = new Date().toISOString()) {
    await dbClient(this.db).run(
      INSERT_SQL,
      node.id,
      node.label,
      node.host,
      node.port,
      node.username,
      node.auth_type,
      maybeEncrypt(node.password ?? null),
      maybeEncrypt(node.private_key ?? null),
      maybeEncrypt(node.passphrase ?? null),
      node.host_key_alg,
      node.host_key_sha256,
      node.jump_node_id ?? null,
      now,
      now,
    )
    return this.get(node.id)
  }

  /** Replace normalized connection fields only if the caller's version is still current. */
  async update(id, node, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = await dbClient(this.db).one(
      UPDATE_SQL,
      node.label,
      node.host,
      node.port,
      node.username,
      node.auth_type,
      maybeEncrypt(node.password ?? null),
      maybeEncrypt(node.private_key ?? null),
      maybeEncrypt(node.passphrase ?? null),
      now,
      id,
      expectedUpdatedAt,
    )
    return row ? { ...row } : null
  }

  /** Rename without reading, decrypting or rewriting stored credentials. */
  async updateLabel(id, label, expectedUpdatedAt) {
    const now = nextUpdatedAt(expectedUpdatedAt)
    if (!now) return null
    const row = await dbClient(this.db).one(UPDATE_LABEL_SQL, label, now, id, expectedUpdatedAt)
    return row ? { ...row } : null
  }

  async remove(id) {
    return (await dbClient(this.db).run(REMOVE_SQL, id)).changes > 0
  }

  /** 'linux' or 'darwin'; null when the node is gone. Detected over SSH, never taken from the form. */
  async platform(id) {
    return (await dbClient(this.db).one(PLATFORM_SQL, id))?.platform ?? null
  }

  /**
   * R6 临时同步出口（B7 删除）：ClusterManager.nodePlatform 同步读取——推理热路径 slotHost(vm) →
   * placement.isNativeNodeVm，以及同步的 docker() / assertLinuxNode()。
   */
  platformSync(id) {
    return dbClient(this.db).oneSync(PLATFORM_SQL, id)?.platform ?? null
  }

  /** Not a connection edit: leaves updated_at alone so a pending node edit does not conflict. */
  async setPlatform(id, platform) {
    return (await dbClient(this.db).run(SET_PLATFORM_SQL, platform, id)).changes > 0
  }

  /** node_id → { address, port }; the gate token stays out of listings. */
  async directLinks() {
    const rows = await dbClient(this.db).many(DIRECT_LINKS_SQL)
    return new Map(rows.map((row) => [row.node_id, { address: row.address, port: row.port }]))
  }

  async getDirectLink(id) {
    const row = await dbClient(this.db).one(GET_DIRECT_LINK_SQL, id)
    return row
      ? { address: row.address, port: row.port, token: maybeDecrypt(row.token), certSha256: row.cert_sha256 || null }
      : null
  }

  async setDirectLink(id, { address, port, token }, now = new Date().toISOString()) {
    await dbClient(this.db).run(SET_DIRECT_LINK_SQL, id, address, port, maybeEncrypt(token), now)
  }

  /** The pin follows the node's gate, not the address: an address edit keeps it. */
  async setDirectLinkCert(id, certSha256) {
    await dbClient(this.db).run(SET_DIRECT_LINK_CERT_SQL, certSha256, id)
  }

  async clearDirectLink(id) {
    return (await dbClient(this.db).run(CLEAR_DIRECT_LINK_SQL, id)).changes > 0
  }
}

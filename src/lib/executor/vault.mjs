/**
 * 凭据库（统一控制面重构 P3.4，设计第 6 节）：控制面保存账号令牌的唯一事实来源，明文不落库。
 *
 * 信封加密：
 *   - 每条记录生成一个 32 字节数据密钥，用 AES-256-GCM 加密载荷（令牌 JSON）；
 *   - 数据密钥再由主密钥（AES-256-GCM）包裹，记录里保存“主密钥 ID + 包裹后的数据密钥”；
 *   - 两层的附加认证数据都是 `vault:v1|<账号>|<授权类别>|<代次>`：记录被挪到别的账号、别的授权类别或改了代次都无法解密（篡改检测）。
 *
 * 主密钥文件：默认与数据库文件同目录的 `credential-master-keys.json`（权限 0600），可用 KIN_CREDENTIAL_MASTER_KEY_FILE 指定。
 * 格式 `{ "active": "<id>", "keys": { "<id>": "<base64 32 字节>" } }`；首次使用时自动生成。
 * 轮换：`scripts/rotate-credential-master-key.mjs` 新增主密钥并设为 active，用 rewrap 重新包裹全部数据密钥（载荷与数据密钥不变），
 * 确认后再 --retire 删除旧主密钥。主密钥文件必须与数据库分开备份：只有数据库备份无法还原令牌。
 *
 * 写入按代次 CAS：expectedRevision 与当前代次不一致时拒绝（stale_revision），新代次必须大于当前代次。
 * BPS 授权的代次是 Worker 令牌代次 + 1（每次刷新递增），与原生授权同样单调。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { withTransaction } from '../db/database.mjs'
import { hasCredentialRecords, vaultRepo } from './repos/vault-repo.mjs'

export const VAULT_GRANTS = Object.freeze(['native', 'bps'])
const AAD_PREFIX = 'vault:v1'

/** 主密钥文件位置：显式配置优先；否则与数据库文件同目录（db 可选，用于取数据库位置）。 */
export function masterKeyFile(env = process.env, db = null) {
  if (env.KIN_CREDENTIAL_MASTER_KEY_FILE) return path.resolve(env.KIN_CREDENTIAL_MASTER_KEY_FILE)
  let location = null
  try {
    location = db?.location?.() || null
  } catch {}
  const dir = location ? path.dirname(location) : env.KIN_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dir, 'credential-master-keys.json')
}

function validKeyring(value) {
  if (!value || typeof value !== 'object' || typeof value.active !== 'string' || !value.keys) return false
  if (!value.keys[value.active]) return false
  return Object.values(value.keys).every((key) => Buffer.from(String(key), 'base64').length === 32)
}

// 写入后对文件与目录 fsync：主密钥先于数据库事务落盘，掉电后不会出现“库里引用了文件里没有的主密钥”（R3 审查 P1-3）
function writeKeyring(file, keyring) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify(keyring, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  fs.chmodSync(file, 0o600)
  try {
    const dirFd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {}
}

/**
 * 首次创建主密钥文件：排他写入（硬链接到目标名，已存在则失败）。两个进程同时首次创建时，
 * 后到的一方改用已存在的文件，不会覆盖对方正在使用的密钥（终审 B7）。返回最终生效的内容。
 */
function createKeyringExclusive(file, keyring) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify(keyring, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmp, file)
  } catch (error) {
    if (error.code === 'EEXIST') return readKeyringFile(file)
    // 不支持硬链接的文件系统（部分 FUSE、对象存储挂载）：改为直接排他创建目标文件（PF.2 复核）
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP'].includes(error.code)) throw error
    let fd
    try {
      fd = fs.openSync(file, 'wx', 0o600)
    } catch (createError) {
      if (createError.code === 'EEXIST') return readKeyringFile(file)
      throw createError
    }
    try {
      fs.writeSync(fd, `${JSON.stringify(keyring, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  try {
    const dirFd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {}
  return keyring
}

/** 轮换前备份主密钥文件（同目录 .bak-<时间>，0600）。 */
export function backupKeyring(file) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(file, backup)
  fs.chmodSync(backup, 0o600)
  return backup
}

export function newMasterKeyId(now = Date.now()) {
  return `mk_${new Date(now).toISOString().slice(0, 10).replaceAll('-', '')}_${crypto.randomBytes(4).toString('hex')}`
}

function readKeyringFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!validKeyring(raw)) throw new Error('credential master key file is invalid')
  try {
    if ((fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600)
  } catch {}
  return raw
}

/**
 * 读取主密钥文件；不存在且 create 为真时生成。返回 { file, active, keys: Map<id, Buffer>, reload() }。
 * 凭据库已有记录时调用方必须传 create=false：主密钥文件丢失（路径配错、恢复时漏了文件）应当报错，
 * 不能静默换一把新密钥让全部记录不可解（R3 审查 P1-3）。
 */
export function loadKeyring({ file = masterKeyFile(), create = true } = {}) {
  let raw
  try {
    raw = readKeyringFile(file)
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw Object.assign(new Error(`credential master key file is unreadable: ${error.message}`), {
        code: 'master_key_file_invalid',
      })
    if (!create)
      throw Object.assign(new Error(`credential master key file ${file} does not exist`), {
        code: 'master_key_file_missing',
      })
    raw = { active: newMasterKeyId(), keys: {} }
    raw.keys[raw.active] = crypto.randomBytes(32).toString('base64')
    raw = createKeyringExclusive(file, raw)
  }
  const keyring = { file, active: raw.active, keys: new Map() }
  const apply = (value) => {
    keyring.active = value.active
    keyring.keys = new Map(Object.entries(value.keys).map(([id, key]) => [id, Buffer.from(key, 'base64')]))
  }
  apply(raw)
  const mtime = () => {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return 0
    }
  }
  let loadedAt = mtime()
  // 运行中进程遇到不认识的主密钥 ID（在线轮换后）时重读文件
  keyring.reload = () => {
    apply(readKeyringFile(file))
    loadedAt = mtime()
    return keyring
  }
  // 写入前检查主密钥文件是否变过：在线轮换后立即改用新的 active 主密钥，--retire 不会删掉刚写入时还在用的旧密钥（R3 复审 N4）
  keyring.refreshIfChanged = () => {
    if (mtime() !== loadedAt) keyring.reload()
    return keyring
  }
  return keyring
}

/** 新增主密钥并设为 active（旧密钥保留，供 rewrap 前的记录解密）。 */
export function addMasterKey(file = masterKeyFile(), id = newMasterKeyId()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!validKeyring(raw)) throw new Error('credential master key file is invalid')
  if (raw.keys[id]) throw new Error(`master key ${id} already exists`)
  raw.keys[id] = crypto.randomBytes(32).toString('base64')
  raw.active = id
  writeKeyring(file, raw)
  return id
}

/** 删除不再被任何记录引用的旧主密钥（调用方先确认 rewrap 完成）。 */
export function retireMasterKeys(file, keep = []) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!validKeyring(raw)) throw new Error('credential master key file is invalid')
  const retained = new Set([raw.active, ...keep])
  const retired = Object.keys(raw.keys).filter((id) => !retained.has(id))
  for (const id of retired) delete raw.keys[id]
  writeKeyring(file, raw)
  return retired
}

function aad(accountResourceId, grant, revision) {
  return Buffer.from(`${AAD_PREFIX}|${accountResourceId}|${grant}|${revision}`)
}

function seal(key, plaintext, associated) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associated)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')
}

function open(key, sealed, associated) {
  const raw = Buffer.from(String(sealed || ''), 'base64')
  if (raw.length < 12 + 16) throw new Error('sealed value is truncated')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAAD(associated)
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
}

export function tokenFingerprint(refreshToken) {
  if (!refreshToken) return null
  return crypto.createHash('sha256').update(String(refreshToken)).digest('hex').slice(0, 16)
}

export class VaultError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * createCredentialVault({ db, keyring }) → { put, get, meta, list, rewrap, remove }
 * secrets：原生授权 { access_token, refresh_token, id_token, api_key, proxy_url }；BPS 授权 { access_token, refresh_token, id_token }。
 */
/** 凭据库是否已有记录（决定主密钥文件缺失时能否自动生成）。 */
export function vaultHasRecords(db) {
  return hasCredentialRecords(db)
}

export function createCredentialVault({ db, keyring = null, now = () => Date.now() }) {
  keyring ||= loadKeyring({ file: masterKeyFile(process.env, db), create: !vaultHasRecords(db) })
  const stamp = () => new Date(now()).toISOString()
  const check = (accountResourceId, grant) => {
    if (!accountResourceId) throw new VaultError('invalid_account', 'account is required', 400)
    if (!VAULT_GRANTS.includes(grant)) throw new VaultError('invalid_grant_kind', `unknown grant ${grant}`, 400)
  }
  const credentials = vaultRepo(db)

  function encrypt(accountResourceId, grant, revision, secrets) {
    try {
      keyring.refreshIfChanged?.()
    } catch {}
    const dataKey = crypto.randomBytes(32)
    const associated = aad(accountResourceId, grant, revision)
    const masterKey = keyring.keys.get(keyring.active)
    return {
      master_key_id: keyring.active,
      wrapped_key: seal(masterKey, dataKey, associated),
      ciphertext: seal(dataKey, Buffer.from(JSON.stringify(secrets)), associated),
    }
  }

  function decrypt(row) {
    if (!keyring.keys.has(row.master_key_id)) {
      try {
        keyring.reload?.()
      } catch {}
    }
    const masterKey = keyring.keys.get(row.master_key_id)
    if (!masterKey) throw new VaultError('master_key_missing', `master key ${row.master_key_id} is not available`, 500)
    const associated = aad(row.account_resource_id, row.grant_kind, row.revision)
    try {
      const dataKey = open(masterKey, row.wrapped_key, associated)
      return JSON.parse(open(dataKey, row.ciphertext, associated).toString('utf8'))
    } catch {
      throw new VaultError('credential_tampered', 'credential record failed authentication', 500)
    }
  }

  const metaOf = (row) =>
    row && {
      account_resource_id: row.account_resource_id,
      grant: row.grant_kind,
      revision: Number(row.revision),
      master_key_id: row.master_key_id,
      token_fingerprint: row.token_fingerprint,
      expires_at: row.expires_at,
      source: row.source,
      source_instance_id: row.source_instance_id,
      updated_at: row.updated_at,
    }

  /**
   * 写入一份凭据。expectedRevision 为 undefined 时只允许首次写入或更高代次；为数字时必须等于当前代次（CAS）。
   * revision 必须大于当前代次（同代次同指纹视为重复写入，直接返回）。
   */
  function put({
    accountResourceId,
    grant,
    revision,
    secrets,
    expectedRevision,
    expiresAt = null,
    source = 'import',
    sourceInstanceId = null,
  }) {
    check(accountResourceId, grant)
    if (!Number.isSafeInteger(Number(revision)) || Number(revision) < 1)
      throw new VaultError('invalid_revision', 'revision must be a positive integer', 400)
    if (!secrets || typeof secrets !== 'object') throw new VaultError('invalid_secrets', 'secrets are required', 400)
    return withTransaction(db, () => {
      const current = credentials.get(accountResourceId, grant)
      const currentRevision = current ? Number(current.revision) : 0
      const fingerprint = tokenFingerprint(secrets.refresh_token)
      if (current && currentRevision === Number(revision) && current.token_fingerprint === fingerprint)
        return { ok: true, duplicate: true, ...metaOf(current) }
      if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== currentRevision)
        throw new VaultError('stale_revision', `expected revision ${expectedRevision}, current ${currentRevision}`)
      if (Number(revision) <= currentRevision)
        throw new VaultError('stale_revision', `revision ${revision} is not newer than ${currentRevision}`)
      const sealed = encrypt(accountResourceId, grant, Number(revision), secrets)
      credentials.upsert({
        account_resource_id: accountResourceId,
        grant_kind: grant,
        revision: Number(revision),
        master_key_id: sealed.master_key_id,
        wrapped_key: sealed.wrapped_key,
        ciphertext: sealed.ciphertext,
        token_fingerprint: fingerprint,
        expires_at: expiresAt,
        source: String(source),
        source_instance_id: sourceInstanceId,
        updated_at: stamp(),
      })
      return { ok: true, ...metaOf(credentials.get(accountResourceId, grant)) }
    })
  }

  /** 解密读取；不存在返回 null。 */
  function get(accountResourceId, grant) {
    check(accountResourceId, grant)
    const row = credentials.get(accountResourceId, grant)
    if (!row) return null
    return { ...metaOf(row), secrets: decrypt(row) }
  }

  function meta(accountResourceId, grant) {
    check(accountResourceId, grant)
    return metaOf(credentials.get(accountResourceId, grant)) || null
  }

  function list() {
    return credentials.listOrdered().map(metaOf)
  }

  /** 用当前 active 主密钥重新包裹所有数据密钥（载荷不变）；整体一个事务。返回重新包裹的条数。 */
  function rewrap() {
    const masterKey = keyring.keys.get(keyring.active)
    return withTransaction(db, () => {
      let count = 0
      for (const row of credentials.all()) {
        if (row.master_key_id === keyring.active) continue
        const oldKey = keyring.keys.get(row.master_key_id)
        if (!oldKey) throw new VaultError('master_key_missing', `master key ${row.master_key_id} is not available`, 500)
        const associated = aad(row.account_resource_id, row.grant_kind, row.revision)
        let dataKey
        try {
          dataKey = open(oldKey, row.wrapped_key, associated)
        } catch {
          throw new VaultError('credential_tampered', 'credential record failed authentication', 500)
        }
        credentials.rewrap(
          row.account_resource_id,
          row.grant_kind,
          keyring.active,
          seal(masterKey, dataKey, associated),
        )
        count++
      }
      return count
    })
  }

  function remove(accountResourceId, grant = null) {
    if (grant) check(accountResourceId, grant)
    return credentials.remove(accountResourceId, grant)
  }

  /** 仍被记录引用的主密钥 ID（retire 前检查）。 */
  function keysInUse() {
    return credentials.masterKeyIds()
  }

  return { put, get, meta, list, rewrap, remove, keysInUse }
}

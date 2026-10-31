import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function secretFile(env, root) {
  return path.join(env.KIN_DATA_DIR || path.join(root, 'data'), 'runtime-secrets.json')
}

function savedSecrets(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid persisted secrets')
    return saved
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('Unable to read persisted runtime secrets')
  }
}

function dotEnvSecrets(root) {
  const values = {}
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const match = line.match(
        /^(TAPMODELS_DB_SECRET|KIN_DB_SECRET|TAPMODELS_API_KEY|KIN_API_KEY|TAPMODELS_ADMIN_PASSWORD|KIN_ADMIN_PASSWORD)=(.*)$/,
      )
      if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return values
}

/** Read the server's API key without generating or rewriting any secret. */
export function readRuntimeApiKey({ env = process.env, root = env.KIN_PROJECT_ROOT || process.cwd() } = {}) {
  const explicit = env.TAPMODELS_API_KEY || env.KIN_API_KEY
  if (explicit) return String(explicit).trim()
  const saved = savedSecrets(secretFile(env, root))
  if (saved.TAPMODELS_API_KEY) return String(saved.TAPMODELS_API_KEY).trim()
  const legacy = dotEnvSecrets(root)
  return String(legacy.TAPMODELS_API_KEY || legacy.KIN_API_KEY || '').trim()
}

/** Docker-generated secrets must live beside the persistent database. */
export function prepareRuntimeSecrets({ env = process.env, root = env.KIN_PROJECT_ROOT || process.cwd() } = {}) {
  const file = secretFile(env, root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const saved = savedSecrets(file)
  const legacy = dotEnvSecrets(root)
  for (const name of ['DB_SECRET', 'API_KEY', 'ADMIN_PASSWORD']) {
    const canonical = `TAPMODELS_${name}`,
      alias = `KIN_${name}`
    const value =
      env[canonical] ||
      env[alias] ||
      (name === 'ADMIN_PASSWORD'
        ? legacy[canonical] || legacy[alias] || saved[canonical]
        : saved[canonical] || legacy[canonical] || legacy[alias]) ||
      crypto.randomBytes(32).toString('hex')
    env[canonical] = value
    saved[canonical] = value
  }
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(saved) + '\n', { mode: 0o600 })
  fs.renameSync(temp, file)
  fs.chmodSync(file, 0o600)
}

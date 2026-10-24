import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Docker-generated secrets must live beside the persistent database. */
export function prepareRuntimeSecrets({ env = process.env, root = env.KIN_PROJECT_ROOT || process.cwd() } = {}) {
  const dir = env.KIN_DATA_DIR || path.join(root, 'data')
  const file = path.join(dir, 'runtime-secrets.json')
  fs.mkdirSync(dir, { recursive: true })
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const legacy = {}
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const match = line.match(
        /^(TAPMODELS_DB_SECRET|KIN_DB_SECRET|TAPMODELS_API_KEY|KIN_API_KEY|TAPMODELS_ADMIN_PASSWORD|KIN_ADMIN_PASSWORD)=(.*)$/,
      )
      if (match) legacy[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
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

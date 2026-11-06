/**
 * 对 Codex Gateway Worker 发一次已签名的 /internal/v1/health 探测。
 *
 *   node scripts/codex-gateway-health.mjs [base_url] [--capabilities]
 *
 * Worker 的每个内部接口都校验 HMAC 时间窗、body hash 和 nonce，所以裸 curl 一定是
 * 401 invalid_internal_auth。base_url 与 token 默认取 .env 的
 * KIN_CODEX_GATEWAY_ADVERTISE_URL / KIN_CODEX_GATEWAY_INTERNAL_TOKEN；托管部署没有在 .env 配置 token 时，
 * 从 <KIN_DATA_DIR>/runtime-secrets.json 只读取得（审计 U2）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRuntimeSecretsReadOnly } from '../src/lib/core/runtime-secrets.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function loadEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq)
    let value = trimmed.slice(eq + 1)
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

const env = { ...loadEnv(path.join(root, '.env')), ...process.env }
loadRuntimeSecretsReadOnly({ env, root })
const args = process.argv.slice(2)
const wantCapabilities = args.includes('--capabilities')
const baseUrl =
  args.find((arg) => !arg.startsWith('--')) || env.KIN_CODEX_GATEWAY_ADVERTISE_URL || 'http://127.0.0.1:8790'
const token = env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''

if (!token) {
  console.error('codex-gateway-health: KIN_CODEX_GATEWAY_INTERNAL_TOKEN 为空，无法签名')
  process.exit(2)
}

const body = ''
const bodyHash = crypto.createHash('sha256').update(body).digest('hex')
const timestamp = new Date().toISOString()
const nonce = crypto.randomBytes(18).toString('base64url')
const signature = crypto
  .createHmac('sha256', token)
  .update(`${timestamp}\n${nonce}\n${bodyHash}\n${body}`)
  .digest('hex')

const target = new URL(wantCapabilities ? '/internal/v1/capabilities' : '/internal/v1/health', baseUrl)
try {
  const response = await fetch(target, {
    method: 'GET',
    headers: {
      'X-Kin-Gateway-Token': token,
      'X-Kin-Gateway-Timestamp': timestamp,
      'X-Kin-Gateway-Nonce': nonce,
      'X-Kin-Gateway-Body-Sha256': bodyHash,
      'X-Kin-Gateway-Signature': signature,
    },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  console.log(`${response.status} ${target.pathname}`)
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
  process.exit(response.ok ? 0 : 1)
} catch (error) {
  console.error(`codex-gateway-health: ${target.href} 无法连接：${error.message}`)
  process.exit(1)
}

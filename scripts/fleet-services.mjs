#!/usr/bin/env node
/**
 * Post-upgrade slot refresh, run inside the control-plane container. The work
 * goes through the running server: only that process holds the cluster SSH
 * links, so a standalone runFleetUpdate fails every node slot with
 * cluster_unavailable.
 *
 *   1. wait until every node that hosts a slot has a ready link
 *   2. wrap-cli sync: local slots take the new kernel / cli-node files, node
 *      slots move onto a content-hashed image with the same payload
 *   3. telemetry: publish the saved VM-native policy and await its acknowledgment
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = String(process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/tapmodels').replace(/\/+$/, '')
const concurrency = Number(process.argv[3] || process.env.KIN_FLEET_CONCURRENCY || 6)
const port = String(process.env.PORT || '8787')
const base = String(process.env.KIN_AUTO_SYNC_BASE || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
const envKey = String(process.env.TAPMODELS_API_KEY || process.env.KIN_API_KEY || '').trim()
const linkWaitMs = Number(process.env.KIN_FLEET_LINK_WAIT_MS || 120_000)
const pollMs = Number(process.env.KIN_FLEET_POLL_MS || 2_000)
// Node image builds stream the payload over SSH; fetch would give up after undici's 300 s header timeout.
const SYNC_TIMEOUT_MS = 30 * 60_000
const statusFile = path.join(root, '.tapmodels-upgrade-status')

async function writeStatus(phase, progress, message) {
  const tmp = `${statusFile}.tmp.${process.pid}`
  try {
    await fs.writeFile(
      tmp,
      `phase=${phase}\nprogress=${progress}\nmessage=${message}\nupdated_at=${new Date().toISOString()}\n`,
      'utf8',
    )
    await fs.rename(tmp, statusFile)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

async function apiKey() {
  if (envKey) return envKey
  try {
    const text = await fs.readFile(`${root}/.env`, 'utf8')
    const line = text.split(/\r?\n/).find((entry) => /^(?:TAPMODELS_API_KEY|KIN_API_KEY)=/.test(entry))
    return line
      ? line
          .slice(line.indexOf('=') + 1)
          .replace(/^['"]|['"]$/g, '')
          .trim()
      : ''
  } catch {
    return ''
  }
}

function call(key, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = { Authorization: `Bearer ${key}` }
    if (payload !== null) headers['content-type'] = 'application/json'
    const req = http.request(new URL(pathname, base), { method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        clearTimeout(timer)
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json })
      })
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new Error(`${pathname}: timed out`)), timeoutMs)
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end(payload)
  })
}

async function healthReady() {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

/** Panel data from a JSON response; a body without data is the request's own failure. */
function dataOf(pathname, response) {
  const data = response.json?.data
  if (data && typeof data === 'object') return data
  throw new Error(`${pathname}: ${response.json?.error?.message || `HTTP ${response.status}`}`)
}

async function slotNodeIds(key) {
  const data = dataOf('/api/panel/vms', await call(key, 'GET', '/api/panel/vms', undefined, 15_000))
  const vms = Array.isArray(data) ? data : data.items
  if (!Array.isArray(vms)) throw new Error('/api/panel/vms: invalid slot list')
  return [...new Set(vms.map((vm) => vm.node_id).filter(Boolean))]
}

/** Not-ready node ids once the wait ends. The server reconnects them on its own after boot. */
async function waitNodeLinks(key, nodeIds) {
  const deadline = Date.now() + linkWaitMs
  let pending = nodeIds
  for (;;) {
    try {
      const data = dataOf(
        '/api/panel/cluster/nodes',
        await call(key, 'GET', '/api/panel/cluster/nodes', undefined, 15_000),
      )
      const ready = new Set((data.items || []).filter((node) => node.link?.state === 'ready').map((node) => node.id))
      pending = nodeIds.filter((id) => !ready.has(id))
    } catch (error) {
      console.warn(`[fleet-services] node link check failed: ${error?.message || error}`)
    }
    if (!pending.length || Date.now() >= deadline) return pending
    await delay(pollMs)
  }
}

function summarizeKernelSync(report) {
  return {
    ok: report.ok === true,
    total: report.total || 0,
    ok_count: report.ok_count || 0,
    failed_count: report.failed_count || 0,
    changed_count: report.changed_count || 0,
    items: (report.items || []).map((item) => ({
      id: item.id,
      node_id: item.node_id || null,
      ok: item.ok === true,
      kernel_changed: item.kernel_changed === true,
      ...(item.ok ? {} : { code: item.code || null, error: item.error || null }),
    })),
  }
}

for (let attempt = 0; attempt < 90; attempt += 1) {
  if (await healthReady()) break
  await delay(pollMs)
}

const key = await apiKey()
if (!key) {
  console.error('[fleet-services] API key is unavailable; slot refresh skipped')
  process.exit(1)
}

try {
  await writeStatus('waiting_links', 83, '正在等待集群节点连接恢复')
  const nodeIds = await slotNodeIds(key)
  if (nodeIds.length) {
    const offline = await waitNodeLinks(key, nodeIds)
    // Slots on these nodes fail below with node_not_ready; the rest still update.
    if (offline.length) console.warn(`[fleet-services] node link not ready: ${offline.join(', ')}`)
  }
  await writeStatus('checking_payload', 86, '正在检查 kernel 和 CLI 是否需要同步')
  const inspectionResponse = await call(key, 'POST', '/api/panel/wrap-cli/sync', { restart: false }, SYNC_TIMEOUT_MS)
  let kernels
  if (inspectionResponse.status >= 200 && inspectionResponse.status < 300 && inspectionResponse.json?.ok !== false) {
    const inspection = dataOf('/api/panel/wrap-cli/sync', inspectionResponse)
    if (inspection.changed_count === 0) {
      kernels = { ...summarizeKernelSync(inspection), skipped: true, reason: 'unchanged' }
      await writeStatus('telemetry', 90, 'kernel 和 CLI 未变化，跳过槽位重启，正在同步必要遥测')
    } else {
      await writeStatus('syncing_payload', 88, '检测到资源变化，正在同步 kernel 和 CLI')
      kernels = summarizeKernelSync(
        dataOf(
          '/api/panel/wrap-cli/sync',
          await call(key, 'POST', '/api/panel/wrap-cli/sync', { restart: true }, SYNC_TIMEOUT_MS),
        ),
      )
    }
  } else {
    // A failed read-only check is inconclusive; preserve the safe full-sync path.
    await writeStatus('syncing_payload', 88, '资源检查失败，正在执行完整槽位同步')
    kernels = summarizeKernelSync(
      dataOf(
        '/api/panel/wrap-cli/sync',
        await call(key, 'POST', '/api/panel/wrap-cli/sync', { restart: true }, SYNC_TIMEOUT_MS),
      ),
    )
  }
  await writeStatus('telemetry', 92, `正在并发同步槽位遥测（并发 ${concurrency}）`)
  const report = dataOf(
    '/api/panel/vms/fleet-update',
    await call(key, 'POST', '/api/panel/vms/fleet-update', { action: 'telemetry', concurrency }, SYNC_TIMEOUT_MS),
  )
  console.log(JSON.stringify({ ...report, kernel_sync: kernels }))
  if (report.skipped_count) {
    for (const item of report.items || []) {
      if (!item.skipped) continue
      const container = item.telemetry?.container || item.id
      console.warn(`[fleet-services] skipped ${item.id}: container unavailable (${container})`)
    }
  }
  if (!kernels.ok || report.failed_count) process.exit(1)
  await writeStatus('completed', 98, '槽位资源和遥测同步完成')
} catch (error) {
  console.error(`[fleet-services] ${error?.message || error}`)
  process.exit(1)
}

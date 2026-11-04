#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { readRuntimeApiKey } from '../src/lib/core/runtime-secrets.mjs'

const root = String(process.env.KIN_PROJECT_ROOT || '/opt/tapmodels').replace(/\/+$/, '')
const port = String(process.env.PORT || '8787')
const base = String(process.env.KIN_AUTO_SYNC_BASE || `http://127.0.0.1:${port}`).replace(/\/+$/, '')

async function healthReady() {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

for (let attempt = 0; attempt < 90; attempt += 1) {
  if (await healthReady()) break
  await delay(2_000)
}

const key = readRuntimeApiKey({ root })
if (!key) {
  console.error('tapmodels: wrap-cli changed but API key is unavailable; slot sync skipped')
  process.exitCode = 1
} else {
  try {
    const response = await fetch(`${base}/api/panel/wrap-cli/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ restart: true }),
      signal: AbortSignal.timeout(180_000),
    })
    const payload = await response.json().catch(() => null)
    const report = payload?.data
    if (!response.ok || !report?.ok) {
      throw new Error(payload?.error?.message || `HTTP ${response.status}`)
    }
    console.log(
      `tapmodels: wrap-cli slot sync complete (${report.ok_count || 0}/${report.total || 0}, failed=${report.failed_count || 0})`,
    )
  } catch (error) {
    console.error(`tapmodels: wrap-cli slot sync failed: ${error?.message || error}`)
    process.exitCode = 1
  }
}

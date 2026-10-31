/**
 * Container path → host path translation for sibling slot containers.
 *
 * Slots are created through `/var/run/docker.sock`, i.e. by the **host** engine,
 * so every `-v` source must be a path the host can resolve. Inside the control
 * plane those paths are container paths (`/opt/tapmodels/...`). Without translation
 * the deployment only works when the install dir happens to have the exact same
 * path on the host — that is why the install dir used to be pinned to
 * `/opt/tapmodels`.
 *
 * Resolution order:
 *   1. `TAPMODELS_HOST_ROOT` / `KIN_HOST_ROOT` — explicit host path of KIN_PROJECT_ROOT.
 *   2. `docker inspect <self>` mounts — exact per-mount `Source`; also correct for
 *      named volumes (`/var/lib/docker/volumes/<vol>/_data`).
 *   3. identity — native (non-container) deploy, host path == container path.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const DOCKER_SOCK = '/var/run/docker.sock'

let cache = null

function defaultDockerJson(name) {
  try {
    const out = execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', name], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(out || '').trim()
  } catch {
    return ''
  }
}

function selfHostname() {
  try {
    return fs.readFileSync('/etc/hostname', 'utf8').trim()
  } catch {
    return ''
  }
}

/** `docker inspect --format '{{json .Mounts}}'` output → [{ destination, source }]. */
export function parseMounts(raw) {
  let doc
  try {
    doc = JSON.parse(String(raw || ''))
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  const out = []
  for (const m of doc) {
    const destination = String(m?.Destination || '').trim()
    const source = String(m?.Source || '').trim()
    if (!destination.startsWith('/') || !source.startsWith('/')) continue
    out.push({ destination: path.resolve(destination), source: path.resolve(source) })
  }
  return out
}

function isInside(child, parent) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/**
 * Longest-destination-first prefix table. Explicit hostRoot covers the whole
 * project; individual mounts override it because they are more specific.
 */
export function buildHostMap({ projectRoot, hostRoot = '', mounts = [] } = {}) {
  const root = projectRoot ? path.resolve(projectRoot) : ''
  const entries = []
  if (root && hostRoot) entries.push({ destination: root, source: path.resolve(hostRoot) })
  for (const m of mounts) {
    if (root && !isInside(m.destination, root)) continue
    entries.push(m)
  }
  entries.sort((a, b) => b.destination.length - a.destination.length)
  return entries
}

/** Map one container path through the table. Unknown paths pass through unchanged. */
export function mapHostPath(p, entries = []) {
  const raw = String(p || '')
  if (!raw) return raw
  const abs = path.resolve(raw)
  for (const e of entries) {
    if (abs === e.destination) return e.source
    if (isInside(abs, e.destination)) return path.join(e.source, path.relative(e.destination, abs))
  }
  return abs
}

/**
 * Discover the mount table of the control-plane container itself.
 * Returns [] when not containerized or when self-inspection fails.
 */
export function discoverSelfMounts({
  projectRoot,
  dockerJson = defaultDockerJson,
  names = [],
  sockPath = DOCKER_SOCK,
} = {}) {
  if (!fs.existsSync(sockPath)) return []
  const root = projectRoot ? path.resolve(projectRoot) : ''
  const candidates = [
    ...names,
    String(process.env.TAPMODELS_CONTAINER_NAME || '').trim(),
    selfHostname(),
    'tapmodels',
  ].filter(Boolean)
  const seen = new Set()
  for (const name of candidates) {
    if (seen.has(name)) continue
    seen.add(name)
    const mounts = parseMounts(dockerJson(name))
    // Only trust a container that actually carries the project tree.
    if (root && mounts.some((m) => isInside(m.destination, root))) return mounts
  }
  return []
}

export function hostMapEntries({ projectRoot, env = process.env, dockerJson, sockPath } = {}) {
  const root = path.resolve(projectRoot || env.KIN_PROJECT_ROOT || process.cwd())
  if (cache && cache.root === root) return cache.entries
  const hostRoot = String(env.TAPMODELS_HOST_ROOT || env.KIN_HOST_ROOT || '').trim()
  const mounts = discoverSelfMounts({ projectRoot: root, dockerJson, sockPath })
  const entries = buildHostMap({ projectRoot: root, hostRoot, mounts })
  cache = { root, entries }
  return entries
}

/** Container path → host path for the given project root. */
export function toHostPath(p, { projectRoot, env, dockerJson, sockPath } = {}) {
  return mapHostPath(p, hostMapEntries({ projectRoot, env, dockerJson, sockPath }))
}

export function resetHostPathCache() {
  cache = null
}

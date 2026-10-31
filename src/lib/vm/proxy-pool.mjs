/**
 * Multi-protocol Proxy Pool (SQLite-backed)
 * - Bulk import
 * - 1 proxy ↔ up to N VMs (`config.bind_limit`, default 5)
 * - Auto-assign a proxy with remaining capacity on VM create
 * - Health probe every 5/10/30/60 min
 * - On failure: disable proxy + disable bound VM scheduling
 *
 * Persistence: `proxies` table + `settings.proxy_pool_config`.
 * Working set stays in memory (probe loop mutates it); save() writes through.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { ProxiesRepo } from '../db/repos/proxies-repo.mjs'
import { normalizeOwnerId, proxyOwnerId, vmOwnerId } from '../admin/resource-owner.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { lookupProxyGeo, lookupProxyGeoV6 } from './proxy-geo.mjs'
import {
  DNS_PRIMARY_AUTO,
  DNS_UPSTREAMS,
  LOCAL_EGRESS_ID,
  isLocalEgressId,
  isLocalEgressProxy,
  localEgressIdForNode,
  localEgressNodeId,
  validDnsPrimary,
} from './egress.mjs'
import {
  normalizeProxyHost,
  proxyEndpoint,
  proxyUrl,
  proxyFamily,
  PROXY_PROTOCOLS,
  proxyDefaultPort,
} from './proxy-address.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'
import { canRevealClusterNodes, annotatePublicLocalProxy } from './local-proxy-nodes.mjs'
import { checkProxyQuality } from './proxy-quality.mjs'

export const MAX_VMS_PER_PROXY = 5
export const BIND_LIMIT_MIN = 1
export const BIND_LIMIT_MAX = 32
export const PROXY_LABEL_MAX = 64

const DEFAULT_CONFIG = {
  probe_interval_min: 10, // 5 | 10 | 30 | 60
  probe_timeout_ms: 8000,
  max_failures: 2, // consecutive failures before disable
  enabled: true,
  disconnect_on_error: false, // experimental: stop slot + tear SOCKS on runtime errors
  geo_timeout_ms: 8000,
  // Bind a proxy -> the slot adopts that exit node's timezone unless the
  // operator pinned one by hand (vm.timezone_source === 'manual').
  follow_proxy_timezone: true,
  bind_limit: MAX_VMS_PER_PROXY,
  // Transparent-egress DNS tried first; the other built-ins remain as fallback.
  dns_primary: DNS_PRIMARY_AUTO,
  dns_disable_svcb_https: false,
  ipv6_enabled: false,
}

export function clampBindLimit(value, fallback = MAX_VMS_PER_PROXY) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(BIND_LIMIT_MAX, Math.max(BIND_LIMIT_MIN, n))
}

export function parseBoundVmIds(value) {
  if (Array.isArray(value)) return normalizeVmIds(value)
  if (value && typeof value === 'object' && Array.isArray(value.ids)) return normalizeVmIds(value.ids)
  if (value == null || value === '') return []
  const raw = String(value).trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      return normalizeVmIds(JSON.parse(raw))
    } catch {
      return []
    }
  }
  if (raw.includes(',')) return normalizeVmIds(raw.split(','))
  return normalizeVmIds([raw])
}

export function encodeBoundVmIds(ids) {
  const next = parseBoundVmIds(ids)
  if (!next.length) return null
  if (next.length === 1) return next[0]
  return JSON.stringify(next)
}

function normalizeVmIds(list, limit = BIND_LIMIT_MAX) {
  const out = []
  const seen = new Set()
  const cap = clampBindLimit(limit, BIND_LIMIT_MAX)
  for (const item of list || []) {
    const id = String(item || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= cap) break
  }
  return out
}

export function boundVmIdsOf(proxy) {
  if (!proxy) return []
  if (Array.isArray(proxy.bound_vm_ids) && proxy.bound_vm_ids.length) {
    return parseBoundVmIds(proxy.bound_vm_ids)
  }
  return parseBoundVmIds(proxy.bound_vm_id)
}

export function proxyHasVm(proxy, vmId) {
  if (!proxy || !vmId) return false
  return boundVmIdsOf(proxy).includes(String(vmId))
}

/**
 * Flat `geo_*` columns -> one nested object, or null when the row was never
 * resolved. A failed lookup still returns an object (carrying `error`) so the
 * panel can tell "detection failed" from "not detected yet".
 */
export function proxyGeoOf(proxy) {
  if (!proxy) return null
  if (!proxy.geo_checked_at && !proxy.geo_ip && !proxy.geo_error) return null
  return {
    ip: proxy.geo_ip || null,
    country: proxy.geo_country || null,
    country_code: proxy.geo_country_code || null,
    region: proxy.geo_region || null,
    city: proxy.geo_city || null,
    isp: proxy.geo_isp || null,
    timezone: proxy.geo_timezone || null,
    checked_at: proxy.geo_checked_at || null,
    error: proxy.geo_error || null,
  }
}

export function proxyGeoV6Of(proxy) {
  if (!proxy) return null
  if (!proxy.geo_v6_checked_at && !proxy.geo_v6_ip && !proxy.geo_v6_error) return null
  return {
    ip: proxy.geo_v6_ip || null,
    country: proxy.geo_v6_country || null,
    country_code: proxy.geo_v6_country_code || null,
    region: proxy.geo_v6_region || null,
    city: proxy.geo_v6_city || null,
    isp: proxy.geo_v6_isp || null,
    timezone: proxy.geo_v6_timezone || null,
    checked_at: proxy.geo_v6_checked_at || null,
    error: proxy.geo_v6_error || null,
  }
}

function setBoundVmIds(proxy, ids) {
  const next = parseBoundVmIds(ids)
  proxy.bound_vm_ids = next
  proxy.bound_vm_id = next[0] || null
  return next
}

function hydrateProxy(proxy) {
  if (!proxy) return proxy
  const ids = parseBoundVmIds(proxy.bound_vm_ids?.length ? proxy.bound_vm_ids : proxy.bound_vm_id)
  return {
    ...proxy,
    platforms: Array.isArray(proxy.platforms) ? [...new Set(proxy.platforms.map((value) => String(value)))] : [],
    host: normalizeProxyHost(proxy.host) || proxy.host,
    bound_vm_ids: ids,
    bound_vm_id: ids[0] || null,
  }
}

function uid(prefix = 'px') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

function isSocksPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function looksLikeHost(value) {
  const host = String(value || '').trim()
  if (!host || /^\d+$/.test(host)) return false
  return true
}

function localEgressRecord(nodeId = null) {
  return {
    id: localEgressIdForNode(nodeId),
    scheme: 'local',
    kind: 'local',
    host: 'local',
    port: 0,
    username: null,
    password: null,
    raw: 'local',
    enabled: true,
    status: 'ok',
    bound_vm_ids: [],
    created_at: new Date().toISOString(),
  }
}

function proxyRecord({ host, port, username = null, password = null, protocol = 'socks5', scheme, label = null }) {
  protocol = String(scheme || protocol).toLowerCase()
  if (!PROXY_PROTOCOLS.includes(protocol)) return null
  host = normalizeProxyHost(host)
  if (!looksLikeHost(host) || !isSocksPort(port)) return null
  const user = username == null || username === '' ? null : String(username)
  const pass = user == null ? null : password == null ? '' : String(password)
  return {
    scheme: protocol,
    label: label == null ? null : String(label).trim().slice(0, PROXY_LABEL_MAX),
    host: String(host).trim(),
    port: Number(port),
    username: user,
    password: pass,
    raw: `${protocol}://${proxyEndpoint(host, port)}`,
  }
}

/** Structured host / port / username / password import. */
export function parseProxyFields(fields = {}) {
  return proxyRecord({
    host: fields.host,
    port: fields.port,
    username: fields.username ?? fields.user,
    password: fields.password ?? fields.pass,
    protocol: fields.protocol || fields.scheme,
    label: fields.label ?? fields.name,
  })
}

function lifetimeFields(input, current = {}) {
  const has = (key) => Object.hasOwn(input, key)
  const raw = has('expires_at') ? input.expires_at : current.expires_at
  if (raw != null && raw !== '' && (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))))
    throw new Error('invalid_expires_at')
  const expires_at = raw == null || raw === '' ? null : new Date(raw).toISOString()
  const fallback_mode = has('fallback_mode') ? input.fallback_mode : current.fallback_mode || 'none'
  if (!['none', 'proxy', 'direct'].includes(fallback_mode)) throw new Error('invalid_fallback_mode')
  const backup_proxy_id =
    fallback_mode === 'proxy'
      ? String(has('backup_proxy_id') ? input.backup_proxy_id || '' : current.backup_proxy_id || '')
      : null
  if (fallback_mode === 'proxy' && !backup_proxy_id) throw new Error('backup_proxy_required')
  if (has('enabled') && typeof input.enabled !== 'boolean') throw new Error('invalid_enabled')
  return { expires_at, fallback_mode, backup_proxy_id }
}

/** Parse line forms:
 *  socks5://user:pass@host:port
 *  socks5h://user:pass@host:port
 *  user:pass@host:port
 *  host:port
 *  host:port:user:pass
 *  user:pass:host:port
 */
export function parseProxyLine(line) {
  let raw = String(line || '').trim()
  if (!raw || raw.startsWith('#')) return null
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  try {
    if (raw.includes('://')) {
      const u = new URL(raw)
      const protocol = u.protocol.slice(0, -1).toLowerCase()
      if (!PROXY_PROTOCOLS.includes(protocol) || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null
      return proxyRecord({
        host: u.hostname,
        port: u.port || proxyDefaultPort(protocol),
        protocol,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        raw,
      })
    }
    const at = raw.lastIndexOf('@')
    if (at > 0) {
      const cred = raw.slice(0, at)
      const hostPort = raw.slice(at + 1)
      const match = hostPort.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
      if (match) {
        const [, host, port] = match
        const colon = cred.indexOf(':')
        return proxyRecord({
          host,
          port,
          username: colon >= 0 ? cred.slice(0, colon) : cred,
          password: colon >= 0 ? cred.slice(colon + 1) : '',
          raw,
        })
      }
      return null
    }
    if (raw.includes('[') || raw.includes(']')) {
      const match = raw.match(/^\[([^\]]+)\]:(\d+)(?::([^:]*)(?::(.*))?)?$/)
      if (!match || !net.isIPv6(match[1])) return null
      return proxyRecord({ host: match[1], port: match[2], username: match[3], password: match[4], raw })
    }
    // A colon-delimited IPv6 endpoint has no unambiguous port boundary.
    if (net.isIPv6(raw) || net.isIPv6(raw.slice(0, raw.lastIndexOf(':')))) return null
    const parts = raw.split(':')
    if (parts.length === 2) {
      return proxyRecord({ host: parts[0], port: parts[1], raw })
    }
    if (parts.length === 3 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return proxyRecord({ host: parts[0], port: parts[1], username: parts[2], password: '', raw })
    }
    if (parts.length >= 4 && looksLikeHost(parts[0]) && isSocksPort(parts[1])) {
      return proxyRecord({
        host: parts[0],
        port: parts[1],
        username: parts[2],
        password: parts.slice(3).join(':'),
        raw,
      })
    }
    if (parts.length >= 4 && isSocksPort(parts[parts.length - 1]) && looksLikeHost(parts[parts.length - 2])) {
      return proxyRecord({
        host: parts[parts.length - 2],
        port: parts[parts.length - 1],
        username: parts[0],
        password: parts.slice(1, parts.length - 2).join(':'),
        raw,
      })
    }
  } catch {
    return null
  }
  return null
}

/** Emits 'change' whenever proxy health or bindings may have moved (panel live stream). */
export class ProxyPool extends EventEmitter {
  constructor({
    dataDir,
    db,
    onDisableVm,
    onDisconnectVm,
    onEnableVm,
    onRebindVm,
    egressCheck,
    repairEgress,
    geoLookup,
    geoV6Lookup,
    vmNodeOf,
    localExitUrl,
    localExitHealth,
  } = {}) {
    super()
    // One listener per open panel stream.
    this.setMaxListeners(100)
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ProxiesRepo(this.db)
    this.onDisableVm = onDisableVm // (vmId, reason, proxyId) => void
    this.onDisconnectVm = onDisconnectVm // (vmId, reason, proxyId) => void — experimental tear-down
    this.onRebindVm = onRebindVm
    this.onEnableVm = onEnableVm // (vmId, reason, proxyId) => void
    this.egressCheck = egressCheck
    this.repairEgress = repairEgress
    // Injectable so geo detection is testable without leaving the machine.
    this.geoLookup = geoLookup || lookupProxyGeo
    this.geoV6Lookup = geoV6Lookup || lookupProxyGeoV6
    // Per-node local egress: which node a slot runs on, and how to reach / check that node's own route.
    this.vmNodeOf = vmNodeOf // (vmId) => nodeId | null
    this.localExitUrl = localExitUrl // (nodeId) => SOCKS url through the node
    this.localExitHealth = localExitHealth // (nodeId) => { ok, latency_ms, error }
    this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    this._timer = null
    this._probing = false
    this._probeSockets = new Map()
    // Node exits are not pool rows: px-local's geo is the control plane's, a node slot leaves elsewhere.
    this._exitGeo = new Map()
    this._qualityRunning = new Set()
    this.load()
  }

  /** Re-read working set from DB (startup + post-restore). */
  load() {
    try {
      this.state.config = { ...DEFAULT_CONFIG, ...(this.repo.getConfig({}) || {}) }
      this.state.proxies = this.repo.loadAll().map(hydrateProxy)
    } catch {
      this.state = { config: { ...DEFAULT_CONFIG }, proxies: [] }
    }
  }

  reload() {
    this.load()
  }

  /** Re-bind to a fresh DB connection (after backup restore) and re-read. */
  rebind(db) {
    this.db = db
    this.repo = new ProxiesRepo(db)
    this.load()
  }

  save() {
    // Batched rewrites (local-row migration) persist once at the end.
    if (this._saveDeferred) {
      this._savePending = true
      return
    }
    this.repo.setConfig(this.state.config)
    this.repo.replaceAll(
      this.state.proxies.map((p) => ({
        ...p,
        bound_vm_id: encodeBoundVmIds(boundVmIdsOf(p)),
      })),
    )
    this.emit('change')
  }

  /**
   * Live health per bound VM for the panel stream: what a VM row shows next to
   * its SOCKS5 chip, refreshed on every probe instead of the list poll.
   */
  liveStatusByVm() {
    const out = {}
    for (const p of this.state.proxies) {
      const view = {
        id: p.id,
        status: p.status ?? null,
        enabled: p.enabled ?? null,
        blocked_reason: proxyBlockedReason(p, this.state.config.ipv6_enabled) || null,
        latency_ms: p.latency_ms ?? null,
        last_error: p.last_error || null,
        last_probe_at: p.last_probe_at || null,
      }
      for (const vmId of boundVmIdsOf(p)) out[vmId] = view
    }
    return out
  }

  bindLimit() {
    return clampBindLimit(this.state.config?.bind_limit, MAX_VMS_PER_PROXY)
  }

  snapshot({ ownerUserId = undefined } = {}) {
    const limit = this.bindLimit()
    const owner = ownerUserId === undefined ? undefined : normalizeOwnerId(ownerUserId)
    const proxies =
      ownerUserId === undefined ? this.state.proxies : this.state.proxies.filter((p) => proxyOwnerId(p) === owner)
    const available = proxies.filter((p) => !proxyBlockedReason(p, this.state.config.ipv6_enabled))
    const unused = available.filter((p) => p.enabled && boundVmIdsOf(p).length === 0 && p.status !== 'dead').length
    const open = available.filter((p) => p.enabled && p.status !== 'dead' && boundVmIdsOf(p).length < limit).length
    const bound = proxies.filter((p) => boundVmIdsOf(p).length > 0).length
    const dead = proxies.filter((p) => !p.enabled || p.status === 'dead').length
    const ok = available.filter((p) => p.enabled && p.status === 'ok').length
    const slotsUsed = proxies.reduce((n, p) => n + boundVmIdsOf(p).length, 0)
    return {
      config: { ...this.state.config, bind_limit: limit },
      totals: {
        total: proxies.length,
        free: unused,
        open,
        bound,
        ok,
        dead,
        blocked: proxies.length - available.length,
        probing: this._probing,
        slots_used: slotsUsed,
        slots_cap: proxies.length * limit,
        bind_limit: limit,
      },
      proxies: proxies.map((p) => this.publicProxy(p)),
    }
  }

  /**
   * Panel-facing snapshot. Quota is still the shared px-local row; this only
   * attaches per-node bound groups for admin and redacts node names / other
   * tenants' VM ids for `user`.
   */
  panelSnapshot({
    role = 'super_admin',
    ownerUserId = undefined,
    vms = [],
    nodes = [],
    vendorId = '',
    platform = '',
  } = {}) {
    const reveal = canRevealClusterNodes(role)
    const owner = role === 'user' ? normalizeOwnerId(ownerUserId) : undefined
    const snap = this.snapshot({ ownerUserId: owner ? ownerUserId : undefined })
    const vmList = Array.isArray(vms) ? vms : []
    const nodeList = Array.isArray(nodes) ? nodes : []
    const ownerVmIds = owner ? new Set(vmList.filter((vm) => vmOwnerId(vm) === owner).map((vm) => String(vm.id))) : null
    if (owner) {
      const shown = new Set(snap.proxies.map((p) => p.id))
      const locals = this.state.proxies.filter(
        (p) => isLocalEgressProxy(p) && !shown.has(p.id) && boundVmIdsOf(p).some((id) => ownerVmIds.has(String(id))),
      )
      snap.proxies.unshift(...locals.map((p) => this.publicProxy(p)))
    }
    snap.proxies = snap.proxies
      .map((p) => annotatePublicLocalProxy(p, { reveal, nodes: nodeList, ownerVmIds }))
      .filter(Boolean)
    const vmById = new Map(vmList.map((vm) => [String(vm.id), vm]))
    snap.proxies = snap.proxies.map((proxy) => {
      const platforms = new Set(Array.isArray(proxy.platforms) ? proxy.platforms : [])
      for (const id of proxy.bound_vm_ids || []) {
        const vm = vmById.get(String(id))
        const value = String(
          vm?.platform || (vm?.family === 'codex' ? 'openai' : vm?.family === 'claude' ? 'anthropic' : ''),
        ).trim()
        if (value) platforms.add(value)
      }
      return { ...proxy, platforms: [...platforms] }
    })
    const wantedVendor = String(vendorId || '').trim()
    const wantedPlatform = String(platform || '')
      .trim()
      .toLowerCase()
    if (wantedVendor) snap.proxies = snap.proxies.filter((proxy) => String(proxy.vendor_id || '') === wantedVendor)
    if (wantedPlatform)
      snap.proxies = snap.proxies.filter((proxy) =>
        (proxy.platforms || []).map((value) => String(value).toLowerCase()).includes(wantedPlatform),
      )
    if (wantedVendor || wantedPlatform) {
      const limit = Number(snap.config.bind_limit || 5)
      const available = snap.proxies.filter((proxy) => !proxy.blocked_reason)
      snap.totals = {
        ...snap.totals,
        total: snap.proxies.length,
        free: available.filter(
          (proxy) => proxy.enabled && !(proxy.bound_vm_ids || []).length && proxy.status !== 'dead',
        ).length,
        open: available.filter((proxy) => proxy.enabled && proxy.status !== 'dead' && (proxy.bound_count || 0) < limit)
          .length,
        bound: snap.proxies.filter((proxy) => (proxy.bound_count || 0) > 0).length,
        ok: available.filter((proxy) => proxy.enabled && proxy.status === 'ok').length,
        dead: snap.proxies.filter((proxy) => !proxy.enabled || proxy.status === 'dead').length,
        blocked: snap.proxies.filter((proxy) => !!proxy.blocked_reason).length,
        slots_used: snap.proxies.reduce((sum, proxy) => sum + Number(proxy.bound_count || 0), 0),
        slots_cap: snap.proxies.length * limit,
      }
    }
    return snap
  }

  publicProxy(p) {
    const ids = boundVmIdsOf(p)
    const limit = this.bindLimit()
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    return {
      id: p.id,
      host: p.host,
      port: p.port,
      label: p.label || null,
      has_auth: !!(p.username || p.password),
      status: p.status, // unknown | ok | fail | dead
      enabled: p.enabled,
      blocked_reason: blocked,
      address_family: proxyFamily(p) || null,
      owner_user_id: proxyOwnerId(p),
      vendor_id: p.vendor_id || null,
      vendor_resource_id: p.vendor_resource_id || null,
      platforms: Array.isArray(p.platforms) ? p.platforms.slice() : [],
      bound_vm_id: ids[0] || null,
      bound_vm_ids: ids,
      bound_count: ids.length,
      bind_limit: limit,
      consecutive_failures: p.consecutive_failures || 0,
      latency_ms: p.latency_ms ?? null,
      last_probe_at: p.last_probe_at || null,
      last_error: p.last_error || null,
      created_at: p.created_at,
      kind: isLocalEgressProxy(p) ? 'local' : p.scheme || 'socks5',
      expires_at: p.expires_at || null,
      fallback_mode: p.fallback_mode || 'none',
      backup_proxy_id: p.backup_proxy_id || null,
      node_id: isLocalEgressProxy(p) ? localEgressNodeId(p.id) : undefined,
      scheme: isLocalEgressProxy(p) ? 'local' : p.scheme || 'socks5',
      domain_forward: !!p.domain_forward,
      geo: proxyGeoOf(p),
      geo_v6: proxyGeoV6Of(p),
      quality: p.quality_json ? JSON.parse(p.quality_json) : null,
    }
  }

  findByVendorResource(vendorResourceId) {
    const id = String(vendorResourceId || '').trim()
    if (!id) return null
    return this.state.proxies.find((proxy) => String(proxy.vendor_resource_id || '') === id) || null
  }

  setVendorMetadata(proxyId, { vendorId = undefined, vendorResourceId = undefined, platforms = undefined } = {}) {
    const proxy = this.state.proxies.find((item) => item.id === proxyId)
    if (!proxy) return { ok: false, error: 'proxy_not_found' }
    if (vendorId !== undefined) proxy.vendor_id = vendorId ? String(vendorId) : null
    if (vendorResourceId !== undefined) proxy.vendor_resource_id = vendorResourceId ? String(vendorResourceId) : null
    if (platforms !== undefined) {
      if (!Array.isArray(platforms)) return { ok: false, error: 'invalid_platforms' }
      proxy.platforms = [...new Set(platforms.map((value) => String(value).trim()).filter(Boolean))]
    }
    this.save()
    return { ok: true, proxy: this.publicProxy(proxy) }
  }

  addPlatform(proxyId, platform) {
    const value = String(platform || '').trim()
    const proxy = this.state.proxies.find((item) => item.id === proxyId)
    if (!proxy) return { ok: false, error: 'proxy_not_found' }
    if (!value) return { ok: true, proxy: this.publicProxy(proxy) }
    return this.setVendorMetadata(proxyId, { platforms: [...(proxy.platforms || []), value] })
  }

  /** The control plane's local row (`px-local`). */
  ensureLocal() {
    return this.ensureLocalForNode(null)
  }

  /** One local row per VPS: `px-local` for the control plane, `px-local-<nodeId>` per node. */
  ensureLocalForNode(nodeId = null) {
    const id = localEgressIdForNode(nodeId)
    const existing = this.state.proxies.find((p) => p.id === id)
    if (existing) return { ok: true, created: false, proxy: this.publicProxy(existing) }
    const proxy = localEgressRecord(nodeId)
    const after = this.state.proxies.reduce((at, p, i) => (isLocalEgressProxy(p) ? i + 1 : at), 0)
    this.state.proxies.splice(after, 0, proxy)
    this.save()
    return { ok: true, created: true, proxy: this.publicProxy(proxy) }
  }

  /**
   * Keep node local rows in step with the cluster: a row per node once local
   * egress is in use, and drop rows of removed nodes that hold no slot.
   */
  syncLocalNodes(nodeIds = []) {
    if (!this.state.proxies.some((p) => p.id === LOCAL_EGRESS_ID)) return { created: [], removed: [] }
    const wanted = new Set(nodeIds.map((id) => localEgressIdForNode(id)).filter((id) => id !== LOCAL_EGRESS_ID))
    const created = []
    for (const id of wanted) {
      if (this.state.proxies.some((p) => p.id === id)) continue
      this.ensureLocalForNode(localEgressNodeId(id))
      created.push(id)
    }
    const removed = this.state.proxies
      .filter((p) => localEgressNodeId(p.id) && !wanted.has(p.id) && !boundVmIdsOf(p).length)
      .map((p) => p.id)
    if (removed.length) {
      this.state.proxies = this.state.proxies.filter((p) => !removed.includes(p.id))
      this.save()
    }
    if (created.length || removed.length) this.emit('change')
    return { created, removed }
  }

  _vmNodeOrUndefined(vmId) {
    try {
      return this.vmNodeOf?.(vmId)
    } catch {
      return undefined
    }
  }

  /** Re-probe one node's local row (its SSH link just changed state). */
  async probeLocalNode(nodeId) {
    const p = this.state.proxies.find((x) => x.id === localEgressIdForNode(nodeId) && localEgressNodeId(x.id))
    // An operator-disabled row stays out of automatic probes, as in probeAll.
    if (!p || !p.enabled) return null
    const result = await this.probeOne(p)
    this._applyProbeResult(p, result)
    this.save()
    return result
  }

  /** The local row a slot must use: its own node's, else the control plane's. */
  localTargetForVm(vmId) {
    return localEgressIdForNode(this._vmNodeOrUndefined(vmId) || null)
  }

  /**
   * Which local row a request for `proxyId` lands on when the slot runs on
   * `nodeId` (null = control plane). The generic px-local resolves to the
   * slot's own VPS; another machine's local row is refused.
   */
  resolveLocalTarget(proxyId, nodeId) {
    const target = localEgressIdForNode(nodeId || null)
    if (proxyId !== target && proxyId !== LOCAL_EGRESS_ID) {
      return { ok: false, error: 'local_proxy_node_mismatch', expected: target }
    }
    const targetNode = localEgressNodeId(target)
    if (targetNode) this.ensureLocalForNode(targetNode)
    return { ok: true, id: target }
  }

  /**
   * Move slots off a local row that is not their own VPS's (the shared
   * px-local before per-node rows). Returns the moves so the caller can
   * rewrite each slot's recorded proxy.
   */
  adoptNodeLocalBindings() {
    const moves = []
    this._saveDeferred = true
    try {
      this._adoptNodeLocalBindings(moves)
    } finally {
      this._saveDeferred = false
      if (this._savePending) {
        this._savePending = false
        this.save()
      }
    }
    return moves
  }

  _adoptNodeLocalBindings(moves) {
    for (const p of this.state.proxies.filter((x) => isLocalEgressProxy(x))) {
      for (const vmId of boundVmIdsOf(p)) {
        // `undefined` = the slot no longer exists; leave stale ids where they are.
        if (this.vmNodeOf && this._vmNodeOrUndefined(vmId) === undefined) continue
        const target = this.localTargetForVm(vmId)
        if (target === p.id) continue
        const bound = this.bind(target, vmId, { force: true })
        if (bound.ok) moves.push({ vm_id: vmId, from: p.id, to: target })
      }
    }
  }

  _findProxyRow(parsed) {
    const key = (p) =>
      JSON.stringify([p.scheme || p.protocol || 'socks5', p.host, p.port, p.username || '', p.password || ''])
    const wanted = key(parsed)
    return this.state.proxies.find((p) => key(p) === wanted) || null
  }

  /** Public view of the SOCKS row with these credentials, or null. Never creates. */
  findProxy(fields = {}) {
    const parsed = parseProxyFields(fields)
    const found = parsed ? this._findProxyRow(parsed) : null
    return found ? this.publicProxy(found) : null
  }

  /**
   * Return the SOCKS row with this host/port/username/password, creating it
   * when absent. Same credentials must not allocate a second id.
   */
  ensureProxy(
    fields = {},
    { ownerUserId = null, label = null, vendorId = null, vendorResourceId = null, platforms = [] } = {},
  ) {
    const parsed = parseProxyFields(fields)
    if (!parsed) return { ok: false, error: 'invalid_proxy' }
    const found = this._findProxyRow(parsed)
    if (found) {
      if (vendorResourceId && String(found.vendor_resource_id || '') !== String(vendorResourceId))
        return { ok: false, error: found.vendor_id ? 'proxy_owned_by_supplier' : 'proxy_already_in_pool' }
      return { ok: true, created: false, proxy: this._withAuth(found) }
    }
    const imported = this.importParsed([parsed], { ownerUserId, vendorId, vendorResourceId, platforms })
    const id = imported.items[0]?.id
    const row = this.state.proxies.find((p) => p.id === id)
    if (!row) return { ok: false, error: 'proxy_import_failed' }
    const name = label == null ? '' : String(label).trim().slice(0, 80)
    if (name) {
      row.label = name
      this.save()
    }
    return { ok: true, created: true, proxy: this._withAuth(row) }
  }

  importLines(text, extra = {}) {
    const parsed = []
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!String(line || '').trim() || String(line).trim().startsWith('#')) continue
      parsed.push(parseProxyLine(line) || { __invalid: String(line).trim() })
    }
    const fields = extra.fields || extra.proxies || extra.entries || []
    for (const item of Array.isArray(fields) ? fields : [fields]) {
      if (!item || typeof item !== 'object') continue
      parsed.push(parseProxyFields(item) || { __invalid: `${item.host || ''}:${item.port || ''}` })
    }
    if (extra.host || extra.port) {
      parsed.push(parseProxyFields(extra) || { __invalid: `${extra.host || ''}:${extra.port || ''}` })
    }
    return this.importParsed(parsed, extra)
  }

  importParsed(records = [], extra = {}) {
    const added = []
    const skipped = []
    const lifetime = lifetimeFields(extra)
    if (lifetime.backup_proxy_id && !this.state.proxies.some((p) => p.id === lifetime.backup_proxy_id))
      throw new Error('backup_proxy_not_found')
    // Credentials can select distinct proxies at the same endpoint. Encode a
    // tuple so colons inside credentials cannot collide with field separators.
    const proxyKey = (p) =>
      JSON.stringify([p.scheme || p.protocol || 'socks5', p.host, p.port, p.username || '', p.password || ''])
    const existing = new Set(this.state.proxies.map(proxyKey))
    for (const parsed of records) {
      if (!parsed || parsed.__invalid || !parsed.host || !parsed.port) {
        const label = parsed?.__invalid || ''
        if (label)
          skipped.push({
            line: '[invalid proxy]',
            reason: 'parse_failed',
            message: 'Invalid proxy endpoint; supported protocols: http, https, socks5, socks5h',
          })
        continue
      }
      const key = proxyKey(parsed)
      if (existing.has(key)) {
        skipped.push({ line: proxyEndpoint(parsed.host, parsed.port), reason: 'duplicate' })
        continue
      }
      existing.add(key)
      const proxy = {
        id: uid('px'),
        ...lifetime,
        scheme: parsed.scheme,
        label: parsed.label || null,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        raw: parsed.raw,
        status: 'unknown',
        enabled: true,
        owner_user_id: normalizeOwnerId(extra.ownerUserId || extra.owner_user_id),
        vendor_id: extra.vendorId ? String(extra.vendorId) : null,
        vendor_resource_id: extra.vendorResourceId ? String(extra.vendorResourceId) : null,
        platforms: Array.isArray(extra.platforms)
          ? [...new Set(extra.platforms.map((value) => String(value).trim()).filter(Boolean))]
          : [],
        bound_vm_id: null,
        bound_vm_ids: [],
        consecutive_failures: 0,
        latency_ms: null,
        last_probe_at: null,
        last_error: null,
        created_at: new Date().toISOString(),
      }
      this.state.proxies.push(proxy)
      added.push(this.publicProxy(proxy))
    }
    this.save()
    return { added: added.length, skipped: skipped.length, items: added, skip_details: skipped.slice(0, 20) }
  }

  /**
   * Restore pool↔VM binding after start/restart.
   * Prefer an existing bind, then the VM's last proxy id, then a free allocate.
   */
  ensureBoundToVm(vmId, preferredId = null) {
    if (!vmId) return null
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const existing = this.getProxyForVm(vmId)
    if (existing) return existing
    if (preferredId) {
      const preferred = this.state.proxies.find((p) => p.id === preferredId)
      if (proxyBlockedReason(preferred, this.state.config.ipv6_enabled)) return null
      const bound = this.bind(preferredId, vmId)
      if (bound.ok) return this.getProxyForVm(vmId)
    }
    return this.allocateForVm(vmId)
  }

  vendorIdForVm(vmId) {
    return (
      this.db
        .prepare(
          "SELECT vendor_id FROM vendor_resources WHERE resource_type='vm' AND json_extract(config_json,'$.runtime_vm_id')=?",
        )
        .get(String(vmId || ''))?.vendor_id || null
    )
  }

  /** Allocate one healthy proxy with remaining capacity and bind to vmId */
  allocateForVm(vmId, { ownerUserId = null, role = 'super_admin' } = {}) {
    if (!vmId) return null
    if (this.state.proxies.some((p) => proxyHasVm(p, vmId) && proxyBlockedReason(p, this.state.config.ipv6_enabled)))
      return null
    const vendorId = this.vendorIdForVm(vmId)
    const existing = this.state.proxies.find(
      (p) =>
        (p.vendor_id || null) === vendorId &&
        p.enabled &&
        !proxyBlockedReason(p, this.state.config.ipv6_enabled) &&
        proxyHasVm(p, vmId),
    )
    if (existing) return this.publicProxy(existing)

    const limit = this.bindLimit()
    const owner = normalizeOwnerId(ownerUserId)
    const localTarget = this.localTargetForVm(vmId)
    if (localTarget !== LOCAL_EGRESS_ID && this.state.proxies.some((p) => p.id === LOCAL_EGRESS_ID)) {
      this.ensureLocalForNode(localEgressNodeId(localTarget))
    }
    const candidates = this.state.proxies.filter((p) => {
      if ((p.vendor_id || null) !== vendorId) return false
      if (isLocalEgressProxy(p) && p.id !== localTarget) return false
      if (!p.enabled || p.status === 'dead' || p.status === 'fail') return false
      if (proxyBlockedReason(p, this.state.config.ipv6_enabled)) return false
      if (boundVmIdsOf(p).length >= limit) return false
      return proxyOwnerId(p) === owner
    })
    candidates.sort((a, b) => {
      const score = (x) => (x.status === 'ok' ? 0 : x.status === 'unknown' ? 1 : 2)
      if (score(a) !== score(b)) return score(a) - score(b)
      return boundVmIdsOf(a).length - boundVmIdsOf(b).length
    })
    const pick = candidates[0]
    if (!pick) return null
    const bound = this.bind(pick.id, vmId, { role })
    return bound.ok ? bound.proxy : null
  }

  bind(proxyId, vmId, { force = false } = {}) {
    const vm = String(vmId || '').trim()
    if (isLocalEgressId(proxyId) && vm) {
      // Local egress is the slot's own VPS route: a generic px-local request lands
      // on the slot's node row; another machine's local row is refused.
      const resolved = this.resolveLocalTarget(proxyId, this._vmNodeOrUndefined(vm) || null)
      if (!resolved.ok) return resolved
      proxyId = resolved.id
    }
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    if ((p.vendor_id || null) !== this.vendorIdForVm(vm)) return { ok: false, error: 'proxy_vendor_scope_forbidden' }
    // Migration moves a slot onto its node row even while that row is marked down.
    if (!force && (!p.enabled || p.status === 'dead')) return { ok: false, error: 'proxy_disabled' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked }
    if (!vm) return { ok: false, error: 'vm_id_required' }
    const currentIds = boundVmIdsOf(p)
    if (!force && !currentIds.includes(vm) && currentIds.length >= this.bindLimit())
      return { ok: false, error: 'proxy_bind_limit', max: this.bindLimit(), bound_vm_ids: currentIds }
    for (const x of this.state.proxies) {
      if (x.id === proxyId) continue
      const ids = boundVmIdsOf(x)
      if (ids.includes(vm))
        setBoundVmIds(
          x,
          ids.filter((id) => id !== vm),
        )
    }
    const ids = boundVmIdsOf(p)
    if (ids.includes(vm)) {
      this.save()
      return { ok: true, proxy: this.publicProxy(p) }
    }
    const limit = this.bindLimit()
    if (!force && ids.length >= limit) {
      return { ok: false, error: 'proxy_bind_limit', max: limit, bound_vm_ids: ids }
    }
    setBoundVmIds(p, [...ids, vm])
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  unbind(proxyId, vmId = null) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const ids = boundVmIdsOf(p)
    const target = vmId == null || vmId === '' ? null : String(vmId).trim()
    const removed = target ? ids.filter((id) => id === target) : ids.slice()
    setBoundVmIds(p, target ? ids.filter((id) => id !== target) : [])
    this.save()
    return { ok: true, proxy: this.publicProxy(p), unbound_vm_ids: removed }
  }

  unbindVm(vmId) {
    const vm = String(vmId || '').trim()
    if (!vm) return
    for (const p of this.state.proxies) {
      const ids = boundVmIdsOf(p)
      if (ids.includes(vm))
        setBoundVmIds(
          p,
          ids.filter((id) => id !== vm),
        )
    }
    this.save()
  }

  setEnabled(proxyId, enabled) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    p.enabled = !!enabled
    if (!enabled) {
      p.status = 'dead'
      p.last_error = null
      this._cascadeDisableVm(p, 'proxy_manually_disabled')
    } else {
      p.status = 'unknown'
      p.consecutive_failures = 0
      p.last_error = null
    }
    this.save()
    return { ok: true, proxy: this.publicProxy(p) }
  }

  remove(proxyId) {
    const idx = this.state.proxies.findIndex((x) => x.id === proxyId)
    if (idx < 0) return { ok: false, error: 'proxy_not_found' }
    const [p] = this.state.proxies.splice(idx, 1)
    for (const row of this.state.proxies) {
      if (row.backup_proxy_id === proxyId) {
        row.backup_proxy_id = null
        row.fallback_mode = 'none'
      }
    }
    this.save()
    return { ok: true, removed: this.publicProxy(p) }
  }

  /**
   * Edit one proxy in place. `label` is display-only: a label-only patch skips
   * endpoint validation and reports `connection_changed: false` so the caller
   * can leave bound workers alone. Only keys present in `patch` are touched, so the
   * caller can clear credentials (`username: ''`) without having to resend host
   * and port. Absent key = leave alone; empty string = clear.
   *
   * The merged record goes through proxyRecord() so this shares the exact
   * validation and normalization the import path uses.
   */
  update(proxyId, patch = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k)
    let lifetime
    try {
      lifetime = lifetimeFields(patch, p)
    } catch (e) {
      return { ok: false, error: e.message || 'invalid_expiry' }
    }
    if (isLocalEgressProxy(p) && (lifetime.expires_at || lifetime.fallback_mode !== 'none'))
      return { ok: false, error: 'local_lifetime_readonly' }
    if (lifetime.backup_proxy_id) {
      const seen = new Set([p.id])
      let next = lifetime.backup_proxy_id
      while (next) {
        if (seen.has(next)) return { ok: false, error: 'proxy_fallback_cycle' }
        seen.add(next)
        const target = this.state.proxies.find((v) => v.id === next)
        if (!target) return { ok: false, error: 'backup_proxy_not_found' }
        next = target.fallback_mode === 'proxy' ? target.backup_proxy_id : null
      }
    }
    const metadataChanged = lifetime.expires_at !== (p.expires_at || null)
    const applyLifetime = () => {
      Object.assign(p, lifetime)
      if (p.status === 'expired' && !proxyBlockedReason(p, this.state.config.ipv6_enabled)) p.status = 'unknown'
      if (has('enabled') && p.enabled !== patch.enabled) {
        p.enabled = patch.enabled
        p.status = patch.enabled ? 'unknown' : 'dead'
        p.consecutive_failures = 0
        if (!patch.enabled) {
          p.last_error = null
          this._cascadeDisableVm(p, 'proxy_manually_disabled')
        }
      }
    }
    const connection = ['protocol', 'host', 'port', 'username', 'password'].some(has)
    if (isLocalEgressProxy(p) && connection) return { ok: false, error: 'local_endpoint_readonly' }
    if (
      !connection &&
      !['label', 'domain_forward', 'enabled', 'expires_at', 'fallback_mode', 'backup_proxy_id'].some(has)
    ) {
      return { ok: false, error: 'no_editable_fields' }
    }
    let label = p.label || null
    if (has('label')) {
      if (patch.label != null && typeof patch.label !== 'string') return { ok: false, error: 'invalid_label' }
      label = String(patch.label || '').trim() || null
      if (label && label.length > PROXY_LABEL_MAX) return { ok: false, error: 'label_too_long', max: PROXY_LABEL_MAX }
    }
    let domainForward = !!p.domain_forward
    if (has('domain_forward')) {
      if (typeof patch.domain_forward !== 'boolean') return { ok: false, error: 'invalid_domain_forward' }
      if (patch.domain_forward && isLocalEgressProxy(p)) return { ok: false, error: 'domain_forward_unsupported' }
      domainForward = patch.domain_forward
    }
    const domainChanged = domainForward !== !!p.domain_forward
    if (!connection) {
      applyLifetime()
      p.label = label
      p.domain_forward = domainForward
      if (domainChanged) {
        p.quality_json = null
        p.quality_version = (p.quality_version || 0) + 1
      }
      this.save()
      return {
        ok: true,
        proxy: this.publicProxy(p),
        connection_changed: false,
        metadata_changed: metadataChanged,
        domain_forward_changed: domainChanged,
      }
    }
    const username = has('username') ? patch.username : p.username
    // SOCKS5 has no password-only auth: proxyRecord() drops the password
    // whenever the username is empty. Setting one without the other would
    // therefore report ok while storing nothing — reject instead of no-op'ing.
    if (has('password') && patch.password !== '' && (username == null || username === '')) {
      return { ok: false, error: 'password_without_username' }
    }
    const next = proxyRecord({
      protocol: has('protocol') ? patch.protocol : p.scheme || p.protocol || 'socks5',
      host: has('host') ? patch.host : p.host,
      port: has('port') ? patch.port : p.port,
      username,
      // Clearing the username drops the password with it — proxyRecord()
      // nulls the password whenever the username is empty, so mirror that here
      // rather than carrying over a password that can no longer be sent.
      password: has('password') ? patch.password : username ? p.password : null,
    })
    if (!next) return { ok: false, error: 'invalid_proxy' }
    applyLifetime()
    p.scheme = next.scheme
    p.protocol = next.scheme
    p.host = next.host
    p.port = next.port
    p.username = next.username
    p.password = next.password
    // Imported rows keep the original line in `raw`, which for a
    // socks5://user:pass@host form means a plaintext password sitting in the
    // store. Rewrite it to host:port so editing also cleans that up.
    p.raw = proxyEndpoint(next.host, next.port)
    p.label = label
    p.domain_forward = domainForward
    p.quality_json = null
    p.quality_version = (p.quality_version || 0) + 1
    this.save()
    return {
      ok: true,
      proxy: this.publicProxy(p),
      connection_changed: true,
      metadata_changed: metadataChanged,
      domain_forward_changed: domainChanged,
    }
  }

  async exitUrl(p) {
    let url = isLocalEgressProxy(p) ? '' : this._withAuth(p).url
    const nodeId = isLocalEgressProxy(p) ? localEgressNodeId(p.id) : null
    if (nodeId) {
      if (!this.localExitUrl) throw new Error('node_egress_unavailable')
      url = await this.localExitUrl(nodeId)
      if (!url) throw new Error('node_egress_unavailable')
    }
    return url
  }

  async qualityById(proxyId, { signal, check = checkProxyQuality } = {}) {
    const p = this.state.proxies.find((v) => v.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked }
    if (this._qualityRunning.has(proxyId) || this._qualityRunning.size >= 4)
      return { ok: false, error: 'quality_check_busy' }
    const version = p.quality_version || 0
    this._qualityRunning.add(proxyId)
    try {
      const url = await this.exitUrl(p)
      const result = await check({ proxyId, proxyUrl: url, geoLookup: this.geoLookup, signal })
      signal?.throwIfAborted()
      if (!this.state.proxies.includes(p) || (p.quality_version || 0) !== version)
        return { ok: false, error: 'proxy_changed_during_check' }
      p.quality_json = JSON.stringify(result)
      this.save()
      return { ok: true, report: result }
    } finally {
      this._qualityRunning.delete(proxyId)
    }
  }

  updateConfig(patch = {}) {
    const allowed = [5, 10, 30, 60]
    if (Object.hasOwn(patch, 'dns_disable_svcb_https') && typeof patch.dns_disable_svcb_https !== 'boolean') {
      return { ok: false, error: 'invalid_dns_disable_svcb_https' }
    }
    if (patch.ipv6_enabled != null && typeof patch.ipv6_enabled !== 'boolean') {
      return { ok: false, error: 'invalid_ipv6_enabled' }
    }
    if (patch.dns_primary != null && !validDnsPrimary(patch.dns_primary)) {
      return {
        ok: false,
        error: 'invalid_dns_primary',
        message:
          'dns_primary must be auto, a built-in DNS upstream, or a valid https:// URL with a valid host and port, without userinfo, fragment, whitespace, backslash, or raw comma',
        allowed: [DNS_PRIMARY_AUTO, ...DNS_UPSTREAMS],
      }
    }
    if (patch.dns_primary != null) this.state.config.dns_primary = patch.dns_primary
    if (patch.dns_disable_svcb_https != null) this.state.config.dns_disable_svcb_https = patch.dns_disable_svcb_https
    if (patch.probe_interval_min != null) {
      const n = Number(patch.probe_interval_min)
      if (!allowed.includes(n)) {
        return { ok: false, error: 'invalid_interval', allowed }
      }
      this.state.config.probe_interval_min = n
    }
    if (patch.probe_timeout_ms != null) {
      this.state.config.probe_timeout_ms = Math.max(1000, Number(patch.probe_timeout_ms) || 8000)
    }
    if (patch.geo_timeout_ms != null) {
      this.state.config.geo_timeout_ms = Math.max(1000, Number(patch.geo_timeout_ms) || 8000)
    }
    if (patch.follow_proxy_timezone != null) {
      this.state.config.follow_proxy_timezone = !!patch.follow_proxy_timezone
    }
    if (patch.max_failures != null) {
      this.state.config.max_failures = Math.max(1, Number(patch.max_failures) || 2)
    }
    if (patch.enabled != null) this.state.config.enabled = !!patch.enabled
    if (patch.disconnect_on_error != null) this.state.config.disconnect_on_error = !!patch.disconnect_on_error
    if (patch.bind_limit != null) {
      const n = Number(patch.bind_limit)
      if (!Number.isInteger(n) || n < BIND_LIMIT_MIN || n > BIND_LIMIT_MAX) {
        return { ok: false, error: 'invalid_bind_limit', min: BIND_LIMIT_MIN, max: BIND_LIMIT_MAX }
      }
      this.state.config.bind_limit = n
    }
    if (patch.ipv6_enabled != null) this.state.config.ipv6_enabled = patch.ipv6_enabled
    this.save()
    if (patch.ipv6_enabled === false) {
      for (const [socket, proxy] of this._probeSockets) {
        if (proxyFamily(proxy) === 6) socket.destroy()
      }
    }
    this.restartScheduler()
    return { ok: true, config: this.state.config }
  }

  disconnectOnErrorEnabled() {
    return !!this.state.config.disconnect_on_error
  }

  /**
   * Runtime SOCKS5 failure from a live request.
   * When disconnect_on_error is off this is a no-op (existing cooldown/failover stays).
   */
  reportRuntimeFailure(vmId, error = 'runtime_socks_failure') {
    if (!this.disconnectOnErrorEnabled()) {
      return { ok: true, skipped: true, reason: 'disconnect_on_error_disabled' }
    }
    if (!vmId) return { ok: false, error: 'vm_id_required' }
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    if (!p) return { ok: false, error: 'no_bound_proxy' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: true, skipped: true, reason: blocked }
    this._applyProbeResult(
      p,
      {
        ok: false,
        latency_ms: p.latency_ms ?? null,
        error: String(error || 'runtime_socks_failure'),
      },
      { cascade: false },
    )
    this._cascadeDisconnectVm(p, `proxy_disconnect:${p.last_error || error}`)
    this.save()
    return { ok: true, skipped: false, proxy: this.publicProxy(p) }
  }

  _cascadeDisconnectVm(proxy, reason) {
    const cb = this.onDisconnectVm || this.onDisableVm
    if (typeof cb !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        cb(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  _cascadeDisableVm(proxy, reason) {
    if (typeof this.onDisableVm !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        this.onDisableVm(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  _cascadeEnableVm(proxy, reason) {
    if (typeof this.onEnableVm !== 'function') return
    for (const vmId of boundVmIdsOf(proxy)) {
      try {
        this.onEnableVm(vmId, reason, proxy.id)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Protocol-aware reachability probe: HTTP uses TCP, HTTPS requires verified TLS.
   * SOCKS endpoints must answer method selection; TCP connect alone is not healthy.
   */
  async probeOne(proxy) {
    const blocked = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, scope: 'policy', error: blocked, latency_ms: null }
    if (isLocalEgressProxy(proxy)) {
      const nodeId = localEgressNodeId(proxy.id)
      // Control plane: host default route. A down kin-egress is not "no proxy".
      if (!nodeId || typeof this.localExitHealth !== 'function') {
        return { ok: true, scope: 'local', mode: 'direct', latency_ms: 0 }
      }
      // A node row is as reachable as the node's own link.
      try {
        const h = (await this.localExitHealth(nodeId)) || {}
        // Link still coming up: no verdict yet, keep the row as it was.
        if (h.pending) return { ok: false, scope: 'pending', error: h.error || 'node_link_pending', latency_ms: null }
        return h.ok
          ? { ok: true, scope: 'node', mode: 'direct', latency_ms: h.latency_ms ?? null }
          : { ok: false, scope: 'node', error: h.error || 'node_unreachable', latency_ms: null }
      } catch (err) {
        return { ok: false, scope: 'node', error: String(err?.message || err), latency_ms: null }
      }
    }
    const socks = await this._probeSocks(proxy)
    if (socks.scope === 'policy') return socks
    if (!socks.ok) return { ...socks, scope: 'socks' }
    if (typeof this.egressCheck !== 'function') return { ...socks, scope: 'socks' }
    let eg = this.egressCheck(proxy)
    if (!eg?.ok && typeof this.repairEgress === 'function') {
      try {
        await this.repairEgress(proxy)
      } catch {
        /* keep egress failure */
      }
      eg = this.egressCheck(proxy)
    }
    if (eg?.ok) return { ...socks, scope: 'socks' }
    return {
      ok: false,
      scope: 'egress',
      socks_ok: true,
      latency_ms: socks.latency_ms,
      error: eg?.reason || 'egress_down',
    }
  }

  async _probeSocks(proxy) {
    const blocked = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, scope: 'policy', error: blocked, latency_ms: null }
    const host = normalizeProxyHost(proxy.host)
    if (!host) return { ok: false, error: 'invalid_proxy_host', latency_ms: null }
    const timeout = this.state.config.probe_timeout_ms || 8000
    const started = Date.now()
    return new Promise((resolve) => {
      const scheme = proxy.scheme || 'socks5'
      const socket =
        scheme === 'https'
          ? tls.connect({
              host,
              port: proxy.port,
              servername: net.isIP(host) ? undefined : host,
              rejectUnauthorized: true,
            })
          : net.connect({ host, port: proxy.port })
      this._probeSockets.set(socket, proxy)
      let done = false
      let connected = false
      let greeted = false
      let buf = Buffer.alloc(0)
      const finish = (ok, error) => {
        if (done) return
        done = true
        this._probeSockets.delete(socket)
        try {
          socket.destroy()
        } catch {
          /* */
        }
        const reason = proxyBlockedReason(proxy, this.state.config.ipv6_enabled)
        if (reason) {
          resolve({ ok: false, scope: 'policy', error: reason, latency_ms: null })
          return
        }
        resolve({
          ok,
          latency_ms: Date.now() - started,
          error: error || null,
        })
      }
      socket.setTimeout(timeout)
      socket.on(scheme === 'https' ? 'secureConnect' : 'connect', () => {
        connected = true
        if (scheme === 'http' || scheme === 'https') return finish(true, null)
        // Offer no-auth and user/pass so a working endpoint is not 0xff-killed.
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))
      })
      socket.on('data', (data) => {
        buf = Buffer.concat([buf, data])
        if (buf.length < 2) return
        greeted = true
        if (buf[0] !== 0x05) {
          finish(false, 'not_socks5：请填写 SOCKS5 端口')
          return
        }
        if (buf[1] === 0x00 || buf[1] === 0x02 || buf[1] === 0xff) {
          finish(true, null)
          return
        }
        finish(false, 'not_socks5：请填写 SOCKS5 端口')
      })
      socket.on('timeout', () => finish(false, connected && !greeted ? 'not_socks5：请填写 SOCKS5 端口' : 'timeout'))
      socket.on('error', (e) => {
        const message = String(e.message || e)
        finish(false, connected && !greeted ? 'not_socks5：请填写 SOCKS5 端口' : message)
      })
      socket.on('close', () => {
        if (!done) finish(false, connected && !greeted ? 'not_socks5：请填写 SOCKS5 端口' : 'connection_closed')
      })
    })
  }

  async probeById(proxyId, { connectivity = false } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const version = p.quality_version || 0
    let geoResult
    let result
    if (connectivity && !proxyBlockedReason(p, this.state.config.ipv6_enabled)) {
      const begin = Date.now()
      try {
        const geo = await this.geoLookup(await this.exitUrl(p), { timeoutMs: this.state.config.geo_timeout_ms })
        if (geo.ok) geoResult = geo
        result = {
          ok: !!geo.ok,
          scope: 'exit',
          latency_ms: Date.now() - begin,
          error: geo.ok ? null : geo.error || 'connection_failed',
        }
      } catch {
        result = { ok: false, scope: 'exit', latency_ms: Date.now() - begin, error: 'proxy_connection_failed' }
      }
    } else result = await this.probeOne(p)
    if (!this.state.proxies.includes(p) || (p.quality_version || 0) !== version)
      return { ok: false, error: 'proxy_changed_during_check' }
    if (geoResult) this._applyGeoResult(p, geoResult)
    this._applyProbeResult(p, result)
    this.save()
    return { ok: true, proxy: this.publicProxy(p), probe: result }
  }

  async probeAll({ onlyEnabled = true } = {}) {
    if (this._probing) return { ok: false, error: 'probe_in_progress' }
    this._probing = true
    const results = []
    try {
      const list = this.state.proxies.filter((p) => {
        if (proxyBlockedReason(p, this.state.config.ipv6_enabled)) return false
        if (!onlyEnabled) return true
        if (p.enabled) return true
        return p.status === 'fail' || (p.status === 'dead' && p.last_error)
      })
      for (const p of list) {
        const result = await this.probeOne(p)
        this._applyProbeResult(p, result)
        results.push({ id: p.id, ...result, status: p.status, enabled: p.enabled })
      }
      this.save()
      return { ok: true, total: results.length, results }
    } finally {
      this._probing = false
    }
  }

  /** Config switch for "a freshly bound slot adopts its proxy's timezone". */
  followProxyTimezoneEnabled() {
    return this.state.config?.follow_proxy_timezone !== false
  }

  /**
   * Resolve one proxy's exit-node location through the proxy itself.
   * `force` re-queries a row that already has a location; without it a cached
   * hit is returned untouched so bind-time detection stays cheap.
   */
  async detectGeo(proxyId, { force = false } = {}) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return { ok: false, error: 'proxy_not_found' }
    const blocked = proxyBlockedReason(p, this.state.config.ipv6_enabled)
    if (blocked) return { ok: false, error: blocked, proxy: this.publicProxy(p) }
    const v4Cached = !force && p.geo_checked_at && p.geo_ip
    const v6Cached = !force && p.geo_v6_checked_at
    if (v4Cached && v6Cached) {
      return {
        ok: true,
        cached: true,
        proxy: this.publicProxy(p),
        geo: proxyGeoOf(p),
        geo_v6: proxyGeoV6Of(p),
      }
    }
    // Control-plane local egress has no SOCKS URL: the lookup leaves over the
    // host default route. A node row looks up through that node's own route.
    let url = this._withAuth(p).url
    const nodeId = isLocalEgressProxy(p) ? localEgressNodeId(p.id) : null
    if (isLocalEgressProxy(p)) url = ''
    if (nodeId) {
      if (typeof this.localExitUrl !== 'function') return { ok: false, error: 'node_egress_unavailable' }
      try {
        url = await this.localExitUrl(nodeId)
      } catch (err) {
        return { ok: false, error: err?.code || 'node_egress_unavailable', proxy: this.publicProxy(p) }
      }
    }
    const timeoutMs = this.state.config?.geo_timeout_ms
    let v4Result = v4Cached ? { ok: true } : await this.geoLookup(url, { timeoutMs })
    if (!v4Cached) this._applyGeoResult(p, v4Result)
    let v6Result = v6Cached ? { ok: true } : await this.geoV6Lookup(url, { timeoutMs })
    if (!v6Cached) this._applyGeoV6Result(p, v6Result)
    this.save()
    const pub = this.publicProxy(p)
    if (!v4Result?.ok) {
      return {
        ok: false,
        error: v4Result?.error || 'geo_lookup_failed',
        proxy: pub,
        geo: proxyGeoOf(p),
        geo_v6: proxyGeoV6Of(p),
      }
    }
    return {
      ok: true,
      cached: v4Cached && v6Cached,
      proxy: pub,
      geo: proxyGeoOf(p),
      geo_v6: proxyGeoV6Of(p),
    }
  }

  async detectGeoAll({ onlyEnabled = true, force = false } = {}) {
    const list = this.state.proxies.filter((p) => (onlyEnabled ? p.enabled : true))
    const results = []
    for (const p of list) {
      const result = await this.detectGeo(p.id, { force })
      results.push({
        id: p.id,
        ok: !!result.ok,
        cached: !!result.cached,
        error: result.ok ? null : result.error || null,
        geo: result.geo ?? null,
        geo_v6: result.geo_v6 ?? null,
      })
    }
    return { ok: true, total: results.length, results }
  }

  _applyGeoResult(p, result) {
    p.geo_checked_at = new Date().toISOString()
    if (!result?.ok) {
      // Keep the previous location: a transient lookup failure should not blank
      // out a known exit node the slot timezone may already follow.
      p.geo_error = String(result?.error || 'geo_lookup_failed').slice(0, 200)
      return
    }
    const geo = result.geo || {}
    p.geo_error = null
    p.geo_ip = geo.ip || null
    p.geo_country = geo.country || null
    p.geo_country_code = geo.country_code || null
    p.geo_region = geo.region || null
    p.geo_city = geo.city || null
    p.geo_isp = geo.isp || null
    p.geo_timezone = validTimezone(geo.timezone) || null
  }

  _applyGeoV6Result(p, result) {
    p.geo_v6_checked_at = new Date().toISOString()
    if (!result?.ok) {
      p.geo_v6_error = String(result?.error || 'geo_ipv6_lookup_failed').slice(0, 200)
      return
    }
    const geo = result.geo || {}
    p.geo_v6_error = null
    p.geo_v6_ip = geo.ip || null
    p.geo_v6_country = geo.country || null
    p.geo_v6_country_code = geo.country_code || null
    p.geo_v6_region = geo.region || null
    p.geo_v6_city = geo.city || null
    p.geo_v6_isp = geo.isp || null
    p.geo_v6_timezone = validTimezone(geo.timezone) || null
  }

  /**
   * Location of an exit that is not a pool row (a node slot on local egress,
   * looked up through that node's forwarder). Cached per key for the process;
   * failures are not cached so the next bind retries.
   */
  async exitGeo(key, url, { detect = true, force = false } = {}) {
    const hit = this._exitGeo.get(key)
    if (hit && !force) return { ok: true, cached: true, geo: hit }
    if (!detect) return { ok: false, error: 'exit_geo_unknown' }
    const result = await this.geoLookup(url, { timeoutMs: this.state.config?.geo_timeout_ms })
    if (!result?.ok) return { ok: false, error: result?.error || 'geo_lookup_failed' }
    const geo = result.geo || {}
    this._exitGeo.set(key, geo)
    return { ok: true, cached: false, geo }
  }

  /** Detected IANA zone of one proxy, '' when unknown. */
  proxyTimezone(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    return p ? validTimezone(p.geo_timezone) : ''
  }

  /** Detected IANA zone of whatever proxy currently serves this VM, '' when unknown. */
  timezoneForVm(vmId) {
    const p = this.state.proxies.find((x) => proxyHasVm(x, vmId))
    return p ? validTimezone(p.geo_timezone) : ''
  }

  _applyProbeResultInner(p, result, { cascade = true } = {}) {
    if (!p.enabled && p.status === 'dead' && !p.last_error) {
      p.latency_ms = result.latency_ms
      p.last_probe_at = new Date().toISOString()
      return
    }
    // Disabled by policy is not a failed probe and must not damage health/history.
    if (result.scope === 'policy' || proxyBlockedReason(p, this.state.config.ipv6_enabled)) return
    if (result.scope === 'pending') return
    p.last_probe_at = new Date().toISOString()
    p.latency_ms = result.latency_ms
    // Node rows are only ever disabled by an operator; a link result must not undo that.
    if (result.scope === 'node' && !p.enabled) return
    if (result.scope === 'node' && !result.ok) {
      // The cluster link owns node health; a node hiccup must not disable the row or park its slots.
      p.status = 'fail'
      p.last_error = result.error || 'node_unreachable'
      return
    }
    if (result.scope === 'egress') {
      p.last_error = `egress_down:${result.error || 'down'}`
      if (p.enabled) p.status = 'ok'
      if (cascade) this._cascadeDisableVm(p, p.last_error)
      return
    }
    if (result.ok) {
      const resume =
        /egress_down|proxy_probe_failed|proxy_expired/.test(String(p.last_error || '')) ||
        p.status === 'fail' ||
        (p.status === 'dead' && !!p.last_error)
      p.status = 'ok'
      p.consecutive_failures = 0
      p.last_error = null
      if (resume && !p.enabled) p.enabled = true
      if (cascade && resume) this._cascadeEnableVm(p, 'proxy_recovered')
      return
    }
    p.consecutive_failures = (p.consecutive_failures || 0) + 1
    p.last_error = result.error || 'probe_failed'
    p.status = 'fail'
    const maxFail = this.state.config.max_failures || 2
    if (p.consecutive_failures >= maxFail) {
      p.enabled = false
      p.status = 'dead'
      if (cascade) this._cascadeDisableVm(p, `proxy_probe_failed:${p.last_error}`)
    }
  }

  _applyProbeResult(p, result, opts = {}) {
    this._applyProbeResultInner(p, result, opts)
    this.emit('change')
  }

  async sweepExpired() {
    if (this._expiryRunning) return
    this._expiryRunning = true
    let dirty = false
    try {
      for (const source of this.state.proxies.slice()) {
        if (!source.enabled || proxyBlockedReason(source, this.state.config.ipv6_enabled) !== 'proxy_expired') continue
        if (source.status !== 'expired') {
          source.status = 'expired'
          source.last_error = 'proxy_expired'
          dirty = true
          this._cascadeDisableVm(source, 'proxy_expired')
        }
        if (!this.onRebindVm || source.fallback_mode === 'none') continue
        for (const vmId of boundVmIdsOf(source).slice()) {
          let target
          if (source.fallback_mode === 'direct') {
            target = this.localTargetForVm(vmId)
            this.ensureLocalForNode(localEgressNodeId(target))
          } else target = source.backup_proxy_id
          const destination = this.state.proxies.find((p) => p.id === target)
          if (
            !destination ||
            !destination.enabled ||
            ['dead', 'fail', 'expired'].includes(destination.status) ||
            proxyBlockedReason(destination, this.state.config.ipv6_enabled)
          )
            continue
          const result = this.bind(target, vmId)
          if (!result.ok) continue
          try {
            await this.onRebindVm(vmId, this.getProxyForVm(vmId), source.id)
          } catch {
            this.onDisableVm?.(vmId, 'proxy_expiry_rebind_failed', target)
          }
        }
      }
      if (dirty) this.save()
    } finally {
      this._expiryRunning = false
    }
  }

  startScheduler() {
    this.stopScheduler()
    void this.sweepExpired().catch(() => {})
    this._expiryTimer = setInterval(() => {
      void this.sweepExpired().catch(() => {})
    }, 30000)
    this._expiryTimer.unref?.()
    if (!this.state.config.enabled) return
    const min = this.state.config.probe_interval_min || 10
    const ms = min * 60 * 1000
    void this.probeAll({ onlyEnabled: true }).catch(() => {})
    this._timer = setInterval(() => {
      this.probeAll({ onlyEnabled: true }).catch(() => {})
    }, ms)
    this._timer.unref?.()
  }

  stopScheduler() {
    if (this._expiryTimer) {
      clearInterval(this._expiryTimer)
      this._expiryTimer = null
    }
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  restartScheduler() {
    this.startScheduler()
  }

  /** For upstream: get socks URL for a VM */
  getProxyForVm(vmId) {
    const vendorId = this.vendorIdForVm(vmId)
    const p = this.state.proxies.find(
      (x) =>
        (x.vendor_id || null) === vendorId &&
        proxyHasVm(x, vmId) &&
        x.enabled &&
        x.status !== 'dead' &&
        !proxyBlockedReason(x, this.state.config.ipv6_enabled),
    )
    if (!p) return null
    return this._withAuth(p)
  }

  /**
   * Look one up by id, credentials included, WITHOUT the enabled/status filter
   * getProxyForVm() applies — an operator editing or copying a proxy needs it to
   * work on the disabled and dead ones too, which are exactly the rows they are
   * most likely to be fixing.
   *
   * The `WithAuth` suffix is deliberate: the return value carries a plaintext
   * password, so it must never be handed to a panel response untouched. Only
   * `POST /api/panel/proxies/:id/reveal` may surface it, and only as a URI.
   */
  /** Display name only — safe for panel responses, unlike getProxyByIdWithAuth(). */
  labelOf(proxyId) {
    return this.state.proxies.find((x) => x.id === proxyId)?.label || null
  }

  getProxyByIdWithAuth(proxyId) {
    const p = this.state.proxies.find((x) => x.id === proxyId)
    if (!p) return null
    return this._withAuth(p)
  }

  _withAuth(p) {
    if (isLocalEgressProxy(p)) {
      return {
        id: p.id || LOCAL_EGRESS_ID,
        url: '',
        host: 'local',
        port: 0,
        scheme: 'local',
        kind: 'local',
        username: null,
        password: null,
      }
    }
    return {
      id: p.id,
      url: proxyUrl(p),
      scheme: p.scheme || p.protocol || 'socks5',
      expires_at: p.expires_at || null,
      host: p.host,
      port: p.port,
      username: p.username || null,
      password: p.password == null ? null : p.password,
      // startProxyEgress reads this to write kin-egress domain_forward; without
      // it the toggle is stored but every helper keeps forwarding IP literals.
      domain_forward: p.domain_forward === true,
    }
  }
}

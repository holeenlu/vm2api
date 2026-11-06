/**
 * Per-unit circuit breaker.
 *
 * One VM credential is one unit. Half-open admits a single probe; a second
 * caller stays out until that probe finishes. 401, model 429, and quota
 * windows must not be recorded here.
 *
 * State is process-local and mirrored onto account runtime `model_states.__circuit`
 * when a repo is attached. Operator `schedulable` is never toggled.
 *
 * R6 B7b：持久化经 async 仓储。读取先 `await load()`（`inspect` / 记录失败与成功 / 面板视图都会先加载）；
 * `admit()` 在 `PoolScheduler.reserve()` 的同步段里调用，只读写内存（调用方已在资格计算时经 `inspect` 加载），
 * 状态变化在后台落盘。落盘只改 `model_states.__circuit` 这一个键（json_set，竞态 R11），不读改写整个 model_states。
 */

const CIRCUIT_KEY = '__circuit'

export class UnitCircuit {
  constructor({ repo = null, failureThreshold = 3, openMs = 30_000, now = () => Date.now() } = {}) {
    this.repo = repo
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3)
    this.openMs = Math.max(1, Number(openMs) || 30_000)
    this.now = now
    this.units = new Map()
  }

  bindRepo(repo) {
    this.repo = repo || null
  }

  configure({ failureThreshold, openMs } = {}) {
    if (failureThreshold != null) this.failureThreshold = Math.max(1, Number(failureThreshold) || 3)
    if (openMs != null) this.openMs = Math.max(1000, Number(openMs) || 30_000)
  }

  async snapshot(accountId) {
    return this.units.get(accountId) || (await this._load(accountId))
  }

  /** 内存里还没有这个单元时从运行态读取（之后都读内存）。 */
  async load(accountId) {
    if (!accountId || this.units.has(accountId)) return
    const unit = await this._load(accountId)
    if (!this.units.has(accountId)) this.units.set(accountId, unit)
  }

  /**
   * Read the gate without taking the half-open probe. Eligibility scans every
   * VM; only reserve() may call admit().
   */
  async inspect(accountId, now = this.now()) {
    if (!accountId) return { ok: true, state: 'closed' }
    await this.load(accountId)
    const unit = this._ensure(accountId, now)
    if (unit.state === 'closed') return { ok: true, state: 'closed' }
    if (unit.state === 'open') {
      return { ok: false, reason: 'circuit_open', until: unit.openUntil, state: 'open' }
    }
    if (unit.probeHeld) {
      return { ok: false, reason: 'circuit_probe', until: now + this.openMs, state: 'half_open' }
    }
    return { ok: true, state: 'half_open', probeAvailable: true }
  }

  /**
   * @returns {{ ok: true, state: string, probe?: boolean } | { ok: false, reason: string, until: number, state: string }}
   */
  admit(accountId, now = this.now()) {
    if (!accountId) return { ok: true, state: 'closed' }
    const unit = this._ensure(accountId, now)
    if (unit.state === 'closed') return { ok: true, state: 'closed' }
    if (unit.state === 'open') {
      if (now < unit.openUntil) {
        return { ok: false, reason: 'circuit_open', until: unit.openUntil, state: 'open' }
      }
      unit.state = 'half_open'
      unit.probeHeld = false
      this._saveInBackground(accountId, unit)
    }
    if (unit.probeHeld) {
      return { ok: false, reason: 'circuit_probe', until: now + this.openMs, state: 'half_open' }
    }
    unit.probeHeld = true
    this._saveInBackground(accountId, unit)
    return { ok: true, state: 'half_open', probe: true }
  }

  async recordFailure(accountId, now = this.now()) {
    if (!accountId) return null
    await this.load(accountId)
    const unit = this._ensure(accountId, now)
    if (unit.state === 'open' && now < unit.openUntil) return unit
    unit.failures += 1
    unit.probeHeld = false
    if (unit.state === 'half_open' || unit.failures >= this.failureThreshold) {
      unit.state = 'open'
      unit.openUntil = now + this.openMs
      unit.failures = this.failureThreshold
    }
    await this._save(accountId, unit)
    return { ...unit }
  }

  releaseProbe(accountId) {
    const unit = this.units.get(accountId)
    if (!unit?.probeHeld) return
    unit.probeHeld = false
    this.units.set(accountId, unit)
  }

  async recordSuccess(accountId) {
    if (!accountId) return null
    await this.load(accountId)
    const unit = this._ensure(accountId, this.now())
    if (unit.state === 'half_open' || unit.probeHeld) {
      unit.state = 'closed'
      unit.failures = 0
      unit.openUntil = 0
      unit.probeHeld = false
      await this._save(accountId, unit)
      return { ...unit }
    }
    if (unit.failures) {
      unit.failures = 0
      await this._save(accountId, unit)
    }
    return { ...unit }
  }

  /** Panel view. Reads without taking the probe; open past its window reads as half_open. */
  async view(accountId, now = this.now()) {
    if (accountId) await this.load(accountId)
    const unit = accountId ? this._ensure(accountId, now) : { state: 'closed', failures: 0, openUntil: 0 }
    return {
      state: unit.state,
      failures: unit.failures,
      threshold: this.failureThreshold,
      open_until: unit.state === 'open' ? unit.openUntil : null,
      open_ms: this.openMs,
    }
  }

  /** Operator reset: close the unit and clear the failure streak. */
  async reset(accountId) {
    if (!accountId) return null
    const unit = { state: 'closed', failures: 0, openUntil: 0, probeHeld: false }
    await this._save(accountId, unit)
    return { ...unit }
  }

  /** 同步：内存里的单元（还没加载时按 closed 处理，调用方应先 `await load()`）。 */
  _ensure(accountId, now) {
    let unit = this.units.get(accountId)
    if (!unit) unit = { state: 'closed', failures: 0, openUntil: 0, probeHeld: false }
    if (unit.state === 'open' && unit.openUntil && now >= unit.openUntil) {
      unit.state = 'half_open'
      unit.probeHeld = false
    }
    this.units.set(accountId, unit)
    return unit
  }

  async _load(accountId) {
    const blank = { state: 'closed', failures: 0, openUntil: 0, probeHeld: false }
    try {
      const row = await this.repo?.get?.(accountId)
      const saved = row?.model_states?.[CIRCUIT_KEY]
      if (!saved || typeof saved !== 'object') return { ...blank }
      return {
        state: saved.state === 'open' || saved.state === 'half_open' ? saved.state : 'closed',
        failures: Number(saved.failures) || 0,
        openUntil: Number(saved.openUntil) || 0,
        probeHeld: false,
      }
    } catch {
      return { ...blank }
    }
  }

  /** 同步调用方（admit）的落盘：不等待；内存已经生效，失败不影响本进程的门控。 */
  _saveInBackground(accountId, unit) {
    this._save(accountId, unit).catch(() => {})
  }

  async _save(accountId, unit) {
    this.units.set(accountId, unit)
    if (!this.repo?.get || !this.repo?.setModelState) return
    try {
      const row = await this.repo.get(accountId)
      if (!row?.vm_id) return
      // 写入时取单元的当前值：后台落盘晚于后续变化完成时也写最新状态
      const current = this.units.get(accountId) || unit
      await this.repo.setModelState(accountId, {
        vmId: row.vm_id,
        key: CIRCUIT_KEY,
        value: {
          state: current.state,
          failures: current.failures,
          openUntil: current.openUntil || 0,
        },
        // open → cooldown；其余保持运行态原状态（原来写回读到的 status）
        status: current.state === 'open' ? 'cooldown' : null,
      })
    } catch {
      /* runtime row may not exist yet; memory still gates this process */
    }
  }
}

export const unitCircuit = new UnitCircuit()

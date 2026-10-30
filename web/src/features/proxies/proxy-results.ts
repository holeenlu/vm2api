import { t as translate } from '@/i18n'

export type Outcome = {
  level: 'success' | 'warning' | 'info' | 'error'
  text: string
}

type SlotResult = { ok?: boolean; error?: unknown } | null | undefined

function reasonOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const nested = rec.error
    if (nested && nested !== value) return reasonOf(nested)
    return String(rec.message || rec.code || '')
  }
  return String(value)
}

/** 绑定后网关会停调度并重载槽位；重载失败时槽位保持停调度，不能报成功。 */
export function bindOutcome(done: string, worker: SlotResult): Outcome {
  if (worker && worker.ok === false) {
    const reason = reasonOf(worker.error)
    return {
      level: 'warning',
      text: reason
        ? translate('proxies:bindReloadFailedReason', { done, reason })
        : translate('proxies:bindReloadFailed', { done }),
    }
  }
  return { level: 'success', text: done }
}

export type ProxyEditResult = {
  workers?: { vm_id: string; ok: boolean; error?: string | null }[]
  egress?: { ok?: boolean; error?: string | null } | null
}

export function editOutcome(data: ProxyEditResult): Outcome {
  const problems: string[] = []
  const failed = (data.workers || []).filter((w) => !w.ok)
  if (failed.length) {
    problems.push(
      translate('proxies:slotReloadFailures', {
        count: failed.length,
        p1: failed.map((w) => w.vm_id).join(translate('proxies:listSeparator')),
      })
    )
  }
  if (data.egress && data.egress.ok === false) {
    const reason = reasonOf(data.egress.error)
    problems.push(
      reason
        ? translate('proxies:exitRestartFailedReason', { reason })
        : translate('proxies:exitRestartFailed')
    )
  }
  if (!problems.length)
    return { level: 'success', text: translate('proxies:saved') }
  return {
    level: 'warning',
    text: translate('proxies:savedWithWarnings', {
      problems: problems.join(translate('proxies:problemSeparator')),
    }),
  }
}

export type ProbeAllResult = {
  ok?: boolean
  error?: string
  total?: number
  results?: { ok?: boolean }[]
}

export type ProbeOneResult = {
  probe?: {
    ok?: boolean
    scope?: string
    latency_ms?: number | null
    error?: string
  }
}

export function probeOneOutcome(data: ProbeOneResult): Outcome {
  const probe = data.probe
  if (probe?.scope === 'pending')
    return { level: 'info', text: translate('proxies:nodeConnecting') }
  if (!probe?.ok)
    return {
      level: 'error',
      text: probe?.error
        ? translate('proxies:connectionFailedReason', { reason: probe.error })
        : translate('proxies:connectionFailed'),
    }
  if (probe.scope === 'local')
    return {
      level: 'success',
      text: translate('proxies:localExitReady'),
    }
  return {
    level: 'success',
    text:
      probe.latency_ms == null
        ? translate('proxies:connectionHealthy')
        : translate('proxies:connectionLatency', { latency: probe.latency_ms }),
  }
}

export function probeAllOutcome(data: ProbeAllResult): Outcome {
  if (data.ok === false) {
    if (data.error === 'probe_in_progress') {
      return { level: 'info', text: translate('proxies:probeInProgress') }
    }
    return {
      level: 'error',
      text: data.error || translate('proxies:probeFailed'),
    }
  }
  const rows = data.results || []
  const ok = rows.filter((r) => r.ok).length
  return {
    level: 'success',
    text: translate('proxies:probeCompleted', {
      p0: ok,
      p1: data.total ?? rows.length,
    }),
  }
}

export function disableConfirmText(bound: number): string {
  return bound
    ? translate('proxies:disableBoundConfirm', { count: bound })
    : translate('proxies:disableUnboundConfirm')
}

export function deleteConfirmText(bound: number): string {
  return bound
    ? translate('proxies:deleteBoundConfirm', { count: bound })
    : translate('proxies:deleteUnboundConfirm')
}

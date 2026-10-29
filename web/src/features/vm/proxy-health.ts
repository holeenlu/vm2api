import { t as tVm } from '@/i18n'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'

export type ProxyHealth = {
  score: number
  tone: StatusTone
  reasons: string[]
}

/**
 * 单槽 SOCKS5 健康分。延迟和连续失败是运营下一步要不要换绑的依据；
 * 有票无代理是 fail-closed，直接 0 分。
 */
export function proxyHealthOf(vm: Vm, proxy: VmProxySnap): ProxyHealth {
  if (vm.has_token && !proxy.host && !vm.proxy_id) {
    return {
      score: 0,
      tone: {
        key: 'bad',
        text: tVm('vm:detailProxyTab.sOCKS5Missing'),
        cls: 'bad',
        label: tVm(
          'vm:proxyHealth.credentialsPresentButNoProxyBoundFailClosed'
        ),
      },
      reasons: [
        tVm(
          'vm:proxyHealth.credentialsPresentButNoProxyBoundOutboundRequestsWill'
        ),
      ],
    }
  }
  if (!proxy.host && !vm.proxy_id) {
    return {
      score: 0,
      tone: {
        key: 'none',
        text: tVm('vm:proxyHealth.notBound'),
        cls: 'none',
        label: tVm('vm:proxyHealth.noSOCKS5Yet'),
      },
      reasons: [tVm('vm:proxyHealth.assignFromThePoolOrBindAnAvailableProxy')],
    }
  }

  return proxyOwnHealthOf(proxy)
}

/**
 * 代理自身的健康分，不掺 VM 绑定关系。一条代理可能绑 0~N 台 VM，
 * 没有单一 vm 可传给 `proxyHealthOf`。
 */
export function proxyOwnHealthOf(proxy: VmProxySnap): ProxyHealth {
  if (proxy.blocked_reason === 'ipv6_disabled') {
    return {
      score: 0,
      tone: {
        key: 'off',
        text: tVm('vm:detailProxyTab.iPv6Disabled'),
        cls: 'off',
        label: tVm(
          'vm:proxyHealth.enableIPv6ProxyEgressInSettingsSOCKS5BeforeUsing'
        ),
      },
      reasons: [
        tVm('vm:proxyHealth.iPv6ProxyEgressIsDisabledBindingAndProbeHistory'),
      ],
    }
  }
  const status = String(proxy.status || '').toLowerCase()
  if (status === 'dead' || status === 'down' || status === 'error') {
    return {
      score: 0,
      tone: {
        key: 'bad',
        text: tVm('vm:proxyHealth.invalid'),
        cls: 'bad',
        label: proxy.last_error || tVm('vm:proxyHealth.latestProbeFailed'),
      },
      reasons: [
        proxy.last_error ||
          tVm('vm:proxyHealth.proxyIsInvalidRebindOrProbeAgain'),
      ],
    }
  }

  const fails = Number(proxy.consecutive_failures || 0)
  const lat = proxy.latency_ms
  let score = 100
  const reasons: string[] = []

  if (fails >= 3) {
    score -= 45
    reasons.push(
      tVm('vm:proxyHealth.consecutiveFailures', { fails: fails, count: fails })
    )
  } else if (fails > 0) {
    score -= 18
    reasons.push(tVm('vm:proxyHealth.failures', { fails: fails, count: fails }))
  }

  if (lat == null) {
    score -= 12
    reasons.push(tVm('vm:proxyHealth.latencyNotProbedYet'))
  } else if (lat >= 1000) {
    score -= 40
    reasons.push(`${lat}ms`)
  } else if (lat >= 500) {
    score -= 22
    reasons.push(`${lat}ms`)
  } else if (lat >= 200) {
    score -= 8
    reasons.push(`${lat}ms`)
  } else {
    reasons.push(`${lat}ms`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const cls =
    score >= 80 ? 'ok' : score >= 55 ? 'caution' : score >= 30 ? 'warn' : 'bad'
  const text =
    cls === 'ok'
      ? tVm('vm:detailProxyTab.health')
      : cls === 'caution'
        ? tVm('vm:proxyHealth.slow')
        : cls === 'warn'
          ? tVm('vm:proxyHealth.unstable')
          : tVm('vm:proxyHealth.abnormal')
  return {
    score,
    tone: {
      key: cls,
      text,
      cls,
      label: reasons.join(' · '),
    },
    reasons,
  }
}

import { t as translate } from '@/i18n'
import type { ClusterApiNode, ClusterLocalStatus } from '@/types/panel-cluster'
import type { HostStats } from '@/types/panel-overview'
import { fmtBytes } from '@/lib/format'

/** 连接详情一行：`tone` 有值时前面画状态点，`hint` 是灰色小字。 */
export type DetailRow = {
  label: string
  value: string
  tone?: 'ok' | 'caution' | 'bad'
  hint?: string
}

function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 60) return translate('cluster:localDetail.minutes', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 48) return translate('cluster:localDetail.hours', { count: hr })
  return translate('cluster:localDetail.days', { count: Math.floor(hr / 24) })
}

function ipv4Prefix24(ip: string): string | null {
  const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/)
  return m ? m[1] : null
}

/** 本机和节点同一个 /24 的地址 = 连节点用的内网口。 */
export function internalAddresses(
  localIps: string[],
  nodes: ClusterApiNode[]
): string[] {
  const nodeNets = new Set(
    nodes.map((n) => ipv4Prefix24(n.host)).filter(Boolean)
  )
  return localIps.filter((ip) => {
    const net = ipv4Prefix24(ip)
    return !!net && nodeNets.has(net) && !nodes.some((n) => n.host === ip)
  })
}

function controlText(c: ClusterLocalStatus['control']): string {
  const listen = translate('cluster:localDetail.listen', {
    value1: c.listen_host ?? '—',
    value2: c.listen_port ?? '—',
  })
  if (c.mode === 'process')
    return `${translate('cluster:localLink.process')} · ${listen}`
  const net = c.network_mode || translate('cluster:localLink.unknownNetwork')
  const kind =
    net === 'host'
      ? translate('cluster:localLink.hostNetwork')
      : net === 'bridge'
        ? 'bridge（NAT）'
        : net
  return translate('cluster:localLink.container', {
    value1: c.container || '',
    value2: `${kind} · ${listen}`,
  })
}

function inboundRow(s: ClusterLocalStatus): DetailRow {
  const { nat, control } = s
  const ip = nat.public_ip || '—'
  const via = nat.observed_via
    ? translate('cluster:localDetail.observedVia', {
        value1: nat.observed_via.label,
      })
    : nat.note
  const natHint =
    nat.behind_nat === true
      ? translate('cluster:localDetail.behindNat')
      : undefined
  const sep = translate('cluster:localDetail.hintSeparator')
  const hint = [via, natHint].filter(Boolean).join(sep) || undefined
  const label = translate('cluster:localDetail.public')
  switch (nat.inbound) {
    case 'closed':
      return {
        label,
        value: translate('cluster:localDetail.inboundClosed', {
          value1: ip,
          value2: control.listen_port,
        }),
        tone: 'ok',
        hint,
      }
    case 'loopback':
      return {
        label,
        value: translate('cluster:localDetail.inboundLoopback', {
          value1: ip,
        }),
        tone: 'ok',
        hint,
      }
    case 'open':
      return {
        label,
        value: translate('cluster:localDetail.inboundOpen', {
          value1: ip,
          value2: control.listen_port,
        }),
        tone: 'caution',
        hint: [translate('cluster:localDetail.openAdvice'), hint]
          .filter(Boolean)
          .join(sep),
      }
    default:
      return { label, value: ip, hint }
  }
}

export function localDetailRows(input: {
  status: ClusterLocalStatus
  host: HostStats | undefined
  nodes: ClusterApiNode[]
}): DetailRow[] {
  const { status, host, nodes } = input
  const { docker, kvm } = status
  const rows: DetailRow[] = [
    {
      label: translate('cluster:localLink.controlPlane'),
      value: controlText(status.control),
    },
    inboundRow(status),
  ]
  const internal = internalAddresses(status.nat.local_ips || [], nodes)
  if (internal.length) {
    rows.push({
      label: translate('cluster:localDetail.internal'),
      value: translate('cluster:localDetail.internalValue', {
        value1: internal.join(translate('cluster:localDetail.listSeparator')),
      }),
    })
  }
  rows.push(
    docker.ok
      ? {
          label: 'Docker',
          value: translate('cluster:localDetail.dockerValue', {
            value1: docker.version ?? '—',
            value2: docker.containers ?? '—',
            value3: docker.running ?? '—',
            value4: docker.slots ?? '—',
          }),
          tone: 'ok',
        }
      : {
          label: 'Docker',
          value: translate('cluster:unavailable'),
          tone: 'bad',
          hint: docker.error || undefined,
        }
  )
  if (kvm) {
    rows.push(
      kvm.ok && kvm.accel === 'kvm'
        ? {
            label: 'KVM',
            value: translate('cluster:localDetail.kvmHardware'),
            tone: 'ok',
          }
        : kvm.ok
          ? {
              label: 'KVM',
              value: translate('cluster:localDetail.kvmSoftware'),
              tone: 'caution',
            }
          : {
              label: 'KVM',
              value: translate('cluster:unavailable'),
              tone: 'bad',
              hint: kvm.error || undefined,
            }
    )
  }
  if (host?.rss) {
    const up = Number(host.proc_uptime) || 0
    rows.push({
      label: translate('cluster:localDetail.controlProcess'),
      value: translate('cluster:localDetail.processValue', {
        value1: fmtBytes(host.rss),
        value2: ago(up * 1000),
      }),
    })
  }
  const ready = nodes.filter((n) => n.link.state === 'ready').length
  if (nodes.length) {
    rows.push({
      label: translate('cluster:localLink.outbound'),
      value: translate('cluster:localDetail.nodesConnected', {
        value1: ready,
        count: nodes.length,
      }),
      tone: ready === nodes.length ? 'ok' : 'caution',
    })
  }
  return rows
}

/** 折叠时那一行摘要。 */
export function localDetailSummary(status: ClusterLocalStatus): string {
  const parts: string[] = []
  const net = status.control.network_mode
  parts.push(
    status.control.mode === 'process'
      ? translate('cluster:localDetail.summaryProcess')
      : translate('cluster:localDetail.summaryControl', {
          value1:
            net === 'host'
              ? translate('cluster:localLink.hostNetwork')
              : net || translate('cluster:localDetail.containerMode'),
        })
  )
  if (status.nat.inbound === 'closed' || status.nat.inbound === 'loopback') {
    parts.push(translate('cluster:localDetail.summaryClosed'))
  } else if (status.nat.inbound === 'open')
    parts.push(translate('cluster:localDetail.summaryOpen'))
  parts.push(
    status.docker.ok
      ? translate('cluster:localDetail.dockerOk')
      : translate('cluster:localDetail.dockerDown')
  )
  if (status.kvm)
    parts.push(
      status.kvm.ok && status.kvm.accel === 'kvm'
        ? translate('cluster:localDetail.kvmOk')
        : translate('cluster:localDetail.kvmDown')
    )
  return parts.join(' · ')
}

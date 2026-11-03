import { useMutation, useQueryClient } from '@tanstack/react-query'
import { i18n, t as translate } from '@/i18n'
import type { ClusterLocalStatus } from '@/types/panel-cluster'
import type { StatusTone } from '@/types/status'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import { StatusMark } from '@/components/status-mark'
import { CLUSTER_LOCAL_KEY } from '@/features/cluster/queries'

const TONE = {
  ok: { key: 'ok', cls: 'ok', text: '' },
  caution: { key: 'caution', cls: 'caution', text: '' },
  bad: { key: 'bad', cls: 'bad', text: '' },
} satisfies Record<string, StatusTone>

type Row = { label: string; value: string; tone?: StatusTone; hint?: string }

function controlText(c: ClusterLocalStatus['control']): string {
  if (c.mode === 'process') return translate('cluster:localLink.process')
  const net = c.network_mode || translate('cluster:localLink.unknownNetwork')
  const kind =
    net === 'host'
      ? translate('cluster:localLink.hostNetwork')
      : net === 'bridge'
        ? 'bridge（NAT）'
        : net
  return translate('cluster:localLink.container', {
    value1: c.container || '',
    value2: kind,
  })
}

function rows(
  s: ClusterLocalStatus,
  outbound: { ready: number; total: number }
): Row[] {
  const { control, nat, docker } = s
  const listen = `${control.listen_host ?? '—'}:${control.listen_port ?? '—'}`
  const inbound: Row =
    nat.inbound === 'loopback'
      ? {
          label: translate('cluster:localLink.inbound'),
          value: translate('cluster:localLink.loopback'),
          tone: TONE.ok,
        }
      : nat.inbound === 'open'
        ? {
            label: translate('cluster:localLink.inbound'),
            value: translate('cluster:localLink.publicReachable', {
              value1: nat.public_ip,
              value2: control.listen_port,
            }),
            tone: TONE.caution,
            hint: translate('cluster:localLink.publicWarning'),
          }
        : nat.inbound === 'closed'
          ? {
              label: translate('cluster:localLink.inbound'),
              value: translate('cluster:localLink.publicUnreachable'),
              tone: TONE.ok,
            }
          : {
              label: translate('cluster:localLink.inbound'),
              value: '—',
              hint: nat.note,
            }
  return [
    {
      label: translate('cluster:localLink.controlPlane'),
      value: controlText(control),
    },
    { label: translate('cluster:localLink.listen'), value: listen },
    {
      label: translate('cluster:localLink.publicEgress'),
      value: nat.public_ip || '—',
      hint: nat.observed_via
        ? translate('cluster:localLink.observedBy', {
            value1: nat.observed_via.label,
          })
        : nat.note || undefined,
    },
    {
      label: 'NAT',
      value:
        nat.behind_nat == null
          ? '—'
          : nat.behind_nat
            ? translate('cluster:localLink.behindNat')
            : translate('cluster:localLink.publicDirect'),
    },
    inbound,
    docker.ok
      ? {
          label: translate('cluster:localLink.docker'),
          value: translate('cluster:localLink.dockerSummary', {
            value1: docker.version,
            value2: docker.running ?? '—',
            value3: docker.containers ?? '—',
            value4: docker.slots ?? '—',
          }),
          tone: TONE.ok,
        }
      : {
          label: translate('cluster:localLink.docker'),
          value: translate('cluster:unavailable'),
          tone: TONE.bad,
          hint: docker.error || undefined,
        },
    {
      label: translate('cluster:localLink.outbound'),
      value: translate('cluster:localLink.connectedNodes', {
        value1: outbound.ready,
        value2: outbound.total,
      }),
      tone:
        outbound.total === 0
          ? undefined
          : outbound.ready === outbound.total
            ? TONE.ok
            : TONE.caution,
    },
  ]
}

export function LocalLink({
  status,
  error,
  outbound,
}: {
  status: ClusterLocalStatus | undefined
  error: Error | null
  outbound: { ready: number; total: number }
}) {
  const { t } = useTranslation('cluster')

  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () =>
      api<ClusterLocalStatus>('/api/panel/cluster/local?refresh=1'),
    onSuccess: (data) => qc.setQueryData(CLUSTER_LOCAL_KEY, data),
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className='border-t px-4 py-3'>
      <div className='mb-2 flex items-center justify-between'>
        <span className='text-[11.5px] text-muted-foreground'>
          {t('localLink.checked', {
            value1: status
              ? ` · ${new Date(status.checked_at).toLocaleTimeString(i18n.language, { timeZone: SYSTEM_TIMEZONE })}`
              : '',
          })}
        </span>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-2 text-xs'
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending
            ? t('localLink.observing')
            : t('localLink.observeAgain')}
        </Button>
      </div>
      {error ? (
        <p className='text-xs text-red-3'>{error.message}</p>
      ) : !status ? (
        <p className='text-xs text-muted-foreground'>{t('loading')}</p>
      ) : (
        <dl className='grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2'>
          {rows(status, outbound).map((row) => (
            <div key={row.label} className='flex min-w-0 items-start gap-2'>
              <dt className='w-20 shrink-0 text-muted-foreground'>
                {row.label}
              </dt>
              <dd className='min-w-0'>
                {row.tone ? (
                  // StatusMark shows its tone text next to the shape; the value is that text.
                  <StatusMark tone={{ ...row.tone, text: row.value }} />
                ) : (
                  <span className='font-mono break-all'>{row.value}</span>
                )}
                {row.hint ? (
                  <div className='text-[11px] text-muted-foreground'>
                    {row.hint}
                  </div>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

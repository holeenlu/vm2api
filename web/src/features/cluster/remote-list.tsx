import { useTranslation } from 'react-i18next'
import { fmtBytes, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { StatusMark } from '@/components/status-mark'
import {
  formatNodeMetric,
  isLiveLink,
  LINK_LATENCY_WARN_MS,
  LINK_STATE_TEXT,
  LINK_TONE,
  directLinkText,
  type ClusterNode,
} from '@/features/cluster/model'
import { PanelCard } from '@/features/overview/panel-card'

const HOST_HOT_PCT = 85

const COL = {
  name: 'min-w-[108px] flex-[1.1] pl-3',
  host: 'min-w-[132px] flex-[1.3]',
  link: 'min-w-[160px] flex-[1.1] whitespace-nowrap',
  metric: 'min-w-[64px] flex-[0.7] text-right',
  spend: 'min-w-[88px] flex-[0.9] pr-2 text-right',
  action: 'w-28 shrink-0 pr-2 text-right',
}

export function RemoteList({
  nodes,
  onJoin,
  onOpen,
  onDisconnect,
  canManage,
}: {
  nodes: ClusterNode[]
  onJoin: () => void
  onOpen: (node: ClusterNode) => void
  onDisconnect: (node: ClusterNode) => void
  canManage: boolean
}) {
  const { t } = useTranslation('cluster')

  return (
    <PanelCard
      title={t('remote.title')}
      meta={t('remote.description')}
      action={
        canManage ? (
          <Button size='sm' variant='outline' onClick={onJoin}>
            {t('connect')}
          </Button>
        ) : undefined
      }
    >
      {nodes.length === 0 ? (
        <EmptyState
          reason={t('remote.empty')}
          actionLabel={canManage ? t('join') : undefined}
          onAction={canManage ? onJoin : undefined}
        />
      ) : (
        <div className='overflow-x-auto'>
          <div className='min-w-[1064px]'>
            <div className='flex h-8 items-center border-b bg-muted/30 text-[11px] font-medium tracking-wide text-muted-foreground/80'>
              <div className={COL.name}>{t('nodes')}</div>
              <div className={COL.host}>IP</div>
              <div className={COL.link}>{t('link')}</div>
              <div className={COL.metric}>CPU</div>
              <div className={COL.metric}>{t('memory')}</div>
              <div className={COL.metric} title={t('remote.memoryHint')}>
                {t('containers')}
              </div>
              <div className={COL.metric} title={t('remote.containerHint')}>
                Docker
              </div>
              <div className={COL.metric}>{t('slots')}</div>
              <div className={COL.metric}>{t('credentials')}</div>
              <div className={COL.metric}>{t('online')}</div>
              <div className={COL.spend}>{t('spend')}</div>
              <div className={COL.action} />
            </div>
            {nodes.map((node) => {
              const live = isLiveLink(node.link)
              const lat =
                live && node.latencyMs != null
                  ? `${Math.round(node.latencyMs)}ms`
                  : ''
              const latHot =
                live &&
                node.latencyMs != null &&
                node.latencyMs > LINK_LATENCY_WARN_MS
              const hs = live ? node.remote?.health?.host : null
              return (
                <div
                  key={node.id}
                  className='flex h-9 items-center border-b border-border/40 text-sm last:border-b-0 hover:bg-muted/50'
                >
                  <div
                    className={cn(
                      COL.name,
                      'flex min-w-0 items-center gap-1.5'
                    )}
                  >
                    <span className='truncate font-medium' title={node.label}>
                      {node.label}
                    </span>
                  </div>
                  <div
                    className={cn(COL.host, 'field-host truncate text-xs')}
                    title={node.host}
                  >
                    {node.host}
                  </div>
                  <div className={cn(COL.link, 'flex items-center gap-1.5')}>
                    <StatusMark tone={LINK_TONE[node.link]} />
                    {node.remote ? (
                      <span className='text-xs'>
                        {LINK_STATE_TEXT[node.remote.link.state]}
                      </span>
                    ) : null}
                    {live && node.remote?.direct_link ? (
                      <span
                        className={cn(
                          'rounded border px-1 text-[10px] leading-4',
                          node.remote.direct_link.state === 'ok'
                            ? 'border-primary/40 text-primary'
                            : 'border-caution-3/50 text-caution-3'
                        )}
                        title={t('remote.directStatus', {
                          value1: directLinkText(node.remote.direct_link),
                        })}
                      >
                        {node.remote.direct_link.state === 'ok'
                          ? t('direct')
                          : t('remote.directFallback')}
                      </span>
                    ) : null}
                    {lat ? (
                      <span
                        className={cn(
                          'field-metric shrink-0 text-[11px]',
                          latHot ? 'text-caution-3' : 'text-muted-foreground'
                        )}
                      >
                        {lat}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      COL.metric,
                      'field-metric',
                      hs && hs.cpu_pct >= HOST_HOT_PCT && 'text-caution-3'
                    )}
                    title={
                      hs
                        ? t('remote.cpuLoad', {
                            value1: hs.cpu_count,
                            value2: [hs.load1, hs.load5, hs.load15]
                              .map((n) => (n == null ? '—' : n.toFixed(2)))
                              .join(' / '),
                          })
                        : undefined
                    }
                  >
                    {hs ? `${hs.cpu_pct.toFixed(0)}%` : '—'}
                  </div>
                  <div
                    className={cn(
                      COL.metric,
                      'field-metric',
                      hs && hs.mem_pct >= HOST_HOT_PCT && 'text-caution-3'
                    )}
                    title={
                      hs
                        ? `${fmtBytes(hs.mem_used)} / ${fmtBytes(hs.mem_total)}`
                        : undefined
                    }
                  >
                    {hs ? `${hs.mem_pct.toFixed(0)}%` : '—'}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {hs?.containers_mem != null
                      ? fmtBytes(hs.containers_mem)
                      : '—'}
                  </div>
                  <div
                    className={cn(COL.metric, 'field-metric')}
                    title={
                      node.docker
                        ? t('remote.runningContainers', {
                            value1: node.docker.running,
                            count: Number(node.docker.total),
                          })
                        : undefined
                    }
                  >
                    {isLiveLink(node.link) && node.docker
                      ? `${fmtNum(node.docker.running)}/${fmtNum(node.docker.total)}`
                      : '—'}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.vmCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.credCount, fmtNum)}
                  </div>
                  <div className={cn(COL.metric, 'field-metric')}>
                    {formatNodeMetric(node, node.onlineCredCount, fmtNum)}
                  </div>
                  <div className={cn(COL.spend, 'field-metric')}>
                    {formatNodeMetric(node, node.spendUsd, (n) => fmtUsd(n, 2))}
                  </div>
                  <div className={COL.action}>
                    {canManage ? (
                      <>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 px-2 text-xs'
                          onClick={() => onOpen(node)}
                        >
                          {t('manage')}
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          className='h-7 px-2 text-xs'
                          onClick={() => onDisconnect(node)}
                        >
                          {t('remove')}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </PanelCard>
  )
}

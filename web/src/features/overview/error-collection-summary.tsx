import { Link } from '@tanstack/react-router'
import type { ErrorCollection } from '@/types/panel-logs'
import { useTranslation } from 'react-i18next'
import { fmtNum } from '@/lib/format'
import { resolveMutedClasses } from '@/lib/log-mute'
import { ERROR_CLASS_TONE } from '@/lib/log-tone'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { errorClassLabel } from '@/features/logs/log-display'
import { PanelCard } from '@/features/overview/panel-card'

function toneStyle(id: string): React.CSSProperties {
  const tone = ERROR_CLASS_TONE[id] || 'bad'
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-bg)`,
    borderColor: `var(--status-${tone})`,
  }
}

/**
 * 错误集合摘要。对齐 index.html 的 `renderErrorCollection(ops, {inLogs:false})`：
 * 分类 chip 跳到日志页并带上 `error_class`（对齐 index.html `openLogErrors`）。
 */
export function ErrorCollectionSummary({
  collection,
  serverMuted,
}: {
  collection: ErrorCollection | undefined
  serverMuted?: string[]
}) {
  const { t: translate } = useTranslation('overview')

  const bag = collection || {}
  const classes = bag.by_class || []
  const muted = new Set(resolveMutedClasses(serverMuted))
  const visible = classes.filter((c) => !muted.has(c.id))
  const hidden = classes.filter((c) => muted.has(c.id))
  const visibleTotal = visible.reduce((n, c) => n + (Number(c.count) || 0), 0)
  const mutedTotal = hidden.reduce((n, c) => n + (Number(c.count) || 0), 0)

  return (
    <PanelCard
      title={translate('overview:errorCollection')}
      meta={
        <span className='tabular-nums'>
          {visibleTotal ? fmtNum(visibleTotal) : null}
          {mutedTotal
            ? translate('overview:mutedErrors', { p0: fmtNum(mutedTotal) })
            : null}
        </span>
      }
      action={
        <Button variant='outline' size='sm' asChild>
          <Link to='/logs' search={{ kind: 'error' }}>
            {translate('overview:viewErrorLogs')}
          </Link>
        </Button>
      }
    >
      <div className='px-4 py-3'>
        {!visible.length && !hidden.length ? (
          <EmptyState reason={translate('overview:noErrorsInWindow')} />
        ) : (
          <div className='flex flex-wrap gap-2'>
            {visible.length ? (
              visible.map((c) => (
                <Link
                  key={c.id}
                  to='/logs'
                  search={{ error_class: c.id, kind: 'error' }}
                  className='inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-opacity hover:opacity-80'
                  style={toneStyle(c.id)}
                  title={translate('overview:filterErrorClass', {
                    p0: errorClassLabel(c.id, c.label),
                  })}
                >
                  <b className='font-semibold'>
                    {errorClassLabel(c.id, c.label)}
                  </b>
                  <span className='tabular-nums'>{fmtNum(c.count)}</span>
                  <em className='text-[10px] not-italic opacity-70'>
                    {c.owner === 'provider'
                      ? translate('overview:upstream')
                      : c.owner === 'client'
                        ? translate('overview:client')
                        : translate('overview:platform')}
                  </em>
                </Link>
              ))
            ) : (
              <span className='text-xs text-muted-foreground'>
                {translate('overview:allVisibleErrorsMuted')}
              </span>
            )}
          </div>
        )}
      </div>
    </PanelCard>
  )
}

import { useState } from 'react'
import { i18n } from '@/i18n'
import type {
  ErrorCodeBucket,
  ErrorCollection,
  IngressHit,
} from '@/types/panel-logs'
import { ChevronDown, EyeOff, Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fmtNum } from '@/lib/format'
import { maskPresentedKey } from '@/lib/log-mute'
import { ERROR_CLASS_TONE } from '@/lib/log-tone'
import { cn } from '@/lib/utils'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { errorClassLabel } from '@/features/logs/log-display'

const LS_OPEN = 'kin_logs_errors_open'

function readOpenPreference(): boolean {
  try {
    return localStorage.getItem(LS_OPEN) !== '0'
  } catch {
    return true
  }
}

function writeOpenPreference(open: boolean): void {
  try {
    localStorage.setItem(LS_OPEN, open ? '1' : '0')
  } catch {
    // Some embedded/private browser contexts deny localStorage access.
  }
}

/** 走 :root 的 --status-* 设计 token，不自造颜色（quality-guidelines）。 */
function toneStyle(id: string): React.CSSProperties {
  const tone = ERROR_CLASS_TONE[id] || 'bad'
  return {
    color: `var(--status-${tone})`,
    backgroundColor: `var(--status-${tone}-bg)`,
    borderColor: `var(--status-${tone})`,
  }
}

function ClassChip({
  id,
  label,
  count,
  muted,
  active,
  onToggleMute,
  onSelect,
}: {
  id: string
  label: string
  count: number
  muted: boolean
  active: boolean
  onToggleMute: (id: string) => void
  onSelect: (id: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        muted && 'border-border/60 bg-muted/40 text-muted-foreground',
        active && 'ring-2 ring-primary/40'
      )}
      style={muted ? undefined : toneStyle(id)}
    >
      <button
        type='button'
        onClick={() => onSelect(id)}
        className='cursor-pointer font-medium'
        title={translate('logs:filterClass', { p0: label })}
      >
        {label} {count}
      </button>
      <button
        type='button'
        onClick={() => onToggleMute(id)}
        className='cursor-pointer opacity-60 transition-opacity hover:opacity-100'
        title={muted ? translate('logs:unmute') : translate('logs:muteClass')}
        aria-label={
          muted
            ? translate('logs:unmuteNamedClass', { p0: label })
            : translate('logs:muteNamedClass', { p0: label })
        }
      >
        {muted ? <Eye className='size-3' /> : <EyeOff className='size-3' />}
      </button>
    </span>
  )
}

function IngressHitsTable({ hits }: { hits: IngressHit[] }) {
  const { t: translate } = useTranslation('logs')

  return (
    <div className='rounded-lg border border-border/60'>
      <div className='border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground'>
        {translate('logs:authFailuresTitle')}
      </div>
      <div className='flex h-7 items-center border-b border-border/60 px-3 text-[11px] font-medium text-muted-foreground/80'>
        <div className='min-w-[160px] flex-[2] truncate'>
          {translate('logs:maskedInboundKey')}
        </div>
        <div className='min-w-[110px] flex-1 truncate px-1.5'>
          {translate('logs:ip')}
        </div>
        <div className='min-w-[110px] flex-1 truncate px-1.5'>
          {translate('logs:errorCode')}
        </div>
        <div className='min-w-[60px] flex-[0.6] truncate px-1.5 text-right'>
          {translate('logs:count')}
        </div>
        <div className='min-w-[80px] flex-1 truncate px-1.5 text-right'>
          {translate('logs:latest')}
        </div>
      </div>
      {hits.map((hit, i) => (
        <div
          key={`${maskPresentedKey(hit.api_key_presented)}-${hit.ip}-${i}`}
          className='flex h-9 items-center border-b border-border/40 px-3 text-xs last:border-b-0'
        >
          {/* 明文不可回显：只渲染掩码结果，不设 title、不提供复制。 */}
          <div className='min-w-[160px] flex-[2] truncate font-mono'>
            {maskPresentedKey(hit.api_key_presented)}
          </div>
          <div className='min-w-[110px] flex-1 truncate px-1.5 font-mono text-muted-foreground'>
            {hit.ip || '—'}
          </div>
          <div className='min-w-[110px] flex-1 truncate px-1.5 text-muted-foreground'>
            {hit.error_code || '—'}
          </div>
          <div className='min-w-[60px] flex-[0.6] truncate px-1.5 text-right font-mono'>
            {hit.count}
          </div>
          <div className='min-w-[80px] flex-1 truncate px-1.5 text-right font-mono text-muted-foreground'>
            {hit.last_ts
              ? new Date(hit.last_ts).toLocaleTimeString(i18n.language)
              : '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 错误码明细。屏蔽的类整行隐掉，除非正在下钻它 ——
 * 「点已屏蔽的 chip 看明细」这条路径靠的就是这个例外。
 */
function ByCodeTable({
  codes,
  onSelectClass,
}: {
  codes: ErrorCodeBucket[]
  onSelectClass: (id: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  return (
    <div className='rounded-lg border border-border/60'>
      <div className='flex h-7 items-center border-b border-border/60 bg-muted/30 px-3 text-[11px] font-medium text-muted-foreground/80'>
        <div className='min-w-[80px] flex-1 truncate'>
          {translate('logs:classification')}
        </div>
        <div className='min-w-[130px] flex-[1.4] truncate px-1.5'>
          {translate('logs:errorCode')}
        </div>
        <div className='min-w-[56px] flex-[0.5] truncate px-1.5 text-right'>
          {translate('logs:count')}
        </div>
        <div className='min-w-[160px] flex-[2.5] truncate px-1.5'>
          {translate('logs:latest')}
        </div>
      </div>
      {codes.map((row) => (
        <button
          key={`${row.error_class}:${row.error_code}`}
          type='button'
          onClick={() => onSelectClass(row.error_class)}
          className='flex h-9 w-full cursor-pointer items-center border-b border-border/40 px-3 text-left text-xs transition-colors last:border-b-0 hover:bg-accent/50'
        >
          <div className='min-w-[80px] flex-1 truncate'>
            {errorClassLabel(row.error_class, row.error_label)}
          </div>
          <div className='min-w-[130px] flex-[1.4] truncate px-1.5 font-mono'>
            {row.error_code || '—'}
          </div>
          <div className='min-w-[56px] flex-[0.5] truncate px-1.5 text-right font-mono'>
            {row.count}
          </div>
          <div className='min-w-[160px] flex-[2.5] truncate px-1.5 text-muted-foreground'>
            {row.last_message || '—'}
            {row.last_model
              ? ` · ${String(row.last_model).replace(/-\d{8}$/, '')}`
              : ''}
          </div>
        </button>
      ))}
    </div>
  )
}

export function ErrorCollectionPanel({
  collection,
  muted,
  activeClass,
  onToggleMute,
  onSelectClass,
}: {
  collection: ErrorCollection
  muted: string[]
  activeClass: string
  onToggleMute: (id: string) => void
  onSelectClass: (id: string) => void
}) {
  const { t: translate } = useTranslation('logs')

  // 值班时的展开偏好跨会话保留；默认展开（异常信号不能默认藏起来）。
  const [open, setOpen] = useState(readOpenPreference)
  const byClass = Array.isArray(collection.by_class) ? collection.by_class : []
  const hits = Array.isArray(collection.ingress_hits)
    ? collection.ingress_hits
    : []
  if (!byClass.length && !hits.length) return null

  const visible = byClass.filter((c) => !muted.includes(c.id))
  const hidden = byClass.filter((c) => muted.includes(c.id))
  const codes = (Array.isArray(collection.by_code) ? collection.by_code : []).filter(
    (row) => !muted.includes(row.error_class) || activeClass === row.error_class
  )
  // ingress_hits 不受屏蔽影响（后端直接查 DB），所以 auth 被屏蔽时
  // 仍能靠这张表追查攻击来源 —— 这正是屏蔽 auth 后它存在的意义。
  const showHits =
    hits.length > 0 && (muted.includes('auth') || activeClass === 'auth')
  const visibleTotal = visible.reduce((n, c) => n + (Number(c.count) || 0), 0)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    writeOpenPreference(next)
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className='rounded-lg border border-border/60 bg-card'
    >
      <CollapsibleTrigger asChild>
        <button
          type='button'
          className='flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors select-none hover:text-foreground'
        >
          <span>{translate('logs:errorCollection')}</span>
          {visibleTotal > 0 ? (
            <span className='font-semibold text-foreground tabular-nums'>
              {fmtNum(visibleTotal)}
            </span>
          ) : null}
          {!open ? (
            // 折叠态在标题行保留分类摘要 —— 折叠是省空间，不是藏异常。
            <span className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5'>
              {visible.map((c) => (
                <span
                  key={c.id}
                  className='whitespace-nowrap tabular-nums'
                  style={{
                    color: `var(--status-${ERROR_CLASS_TONE[c.id] || 'bad'})`,
                  }}
                >
                  {errorClassLabel(c.id, c.label)} {fmtNum(c.count)}
                </span>
              ))}
              {hidden.length ? (
                <span className='whitespace-nowrap'>
                  {translate('logs:mutedClassCount', { count: hidden.length })}
                </span>
              ) : null}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              'ml-auto size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='space-y-2 px-3 pb-3'>
          <div className='flex flex-wrap items-center gap-1.5'>
            {visible.map((c) => (
              <ClassChip
                key={c.id}
                id={c.id}
                label={errorClassLabel(c.id, c.label)}
                count={c.count}
                muted={false}
                active={activeClass === c.id}
                onToggleMute={onToggleMute}
                onSelect={onSelectClass}
              />
            ))}
            {visible.length === 0 && hidden.length > 0 ? (
              <span className='text-xs text-muted-foreground'>
                {translate('logs:allRecentErrorsMuted')}
              </span>
            ) : null}
          </div>
          {hidden.length ? (
            <div className='flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2'>
              <span className='text-xs text-muted-foreground'>
                {translate('logs:mutedClassCount', { count: hidden.length })}
              </span>
              {hidden.map((c) => (
                <ClassChip
                  key={c.id}
                  id={c.id}
                  label={errorClassLabel(c.id, c.label)}
                  count={c.count}
                  muted
                  active={activeClass === c.id}
                  onToggleMute={onToggleMute}
                  onSelect={onSelectClass}
                />
              ))}
            </div>
          ) : null}
          {codes.length ? (
            <div className='pt-1'>
              <ByCodeTable codes={codes} onSelectClass={onSelectClass} />
            </div>
          ) : null}
          {showHits ? (
            <div className='pt-1'>
              <IngressHitsTable hits={hits} />
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

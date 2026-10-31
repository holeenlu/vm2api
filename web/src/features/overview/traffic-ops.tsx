import type { OpsModelRow, OpsWindow } from '@/types/panel-overview'
import { useTranslation } from 'react-i18next'
import { fmtNum, fmtRate } from '@/lib/format'
import { cacheHitPct, fmtHitPct } from '@/lib/vm-usage'
import { formatMetricDuration as fmtMs } from '@/features/logs/display-time'
import { PanelCard, StatCell } from '@/features/overview/panel-card'

type OpsTone = 'ok' | 'warn' | 'bad' | 'neutral'

function slaTone(sla: number | undefined): OpsTone {
  if (sla == null) return 'neutral'
  const p = sla * 100
  if (p < 90) return 'bad'
  if (p < 99) return 'warn'
  return 'ok'
}

function errTone(rate: number | undefined): OpsTone {
  if (rate == null) return 'neutral'
  const p = rate * 100
  if (p >= 10) return 'bad'
  if (p >= 5) return 'warn'
  return 'ok'
}

function ttftTone(p95: number | null | undefined): OpsTone {
  if (p95 == null) return 'neutral'
  if (p95 >= 8000) return 'bad'
  if (p95 >= 4000) return 'warn'
  return 'neutral'
}

const TONE_TEXT: Record<OpsTone, string> = {
  ok: 'text-[color:var(--status-ok)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
  neutral: '',
}

const MODEL_FAMILIES = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' },
] as const

function modelFamilyOf(id: string | undefined): string {
  const s = String(id || '').toLowerCase()
  if (s.includes('haiku')) return 'haiku'
  if (s.includes('opus')) return 'opus'
  if (s.includes('fable') || s.includes('mythos')) return 'fable'
  if (s.includes('sonnet')) return 'sonnet'
  return 'other'
}

/** 按模型家族聚合 `by_model`。对齐 index.html 的 `opsModelFamilyRows`。 */
function opsModelFamilyRows(byModel: OpsModelRow[]): {
  model: string
  requests: number
  errors: number
  avg_first_token_ms: number | null
  avg_duration_ms: number | null
}[] {
  const bag: Record<
    string,
    {
      requests: number
      errors: number
      ttftSum: number
      ttftN: number
      durSum: number
      durN: number
    }
  > = Object.fromEntries(
    MODEL_FAMILIES.map((f) => [
      f.id,
      { requests: 0, errors: 0, ttftSum: 0, ttftN: 0, durSum: 0, durN: 0 },
    ])
  )
  for (const row of byModel || []) {
    const key = modelFamilyOf(row.model)
    const b = bag[key]
    if (!b) continue
    const n = Number(row.requests || 0)
    b.requests += n
    b.errors += Number(row.errors || 0)
    if (row.avg_first_token_ms != null) {
      const samples = Number(row.ttft_samples || n) || 0
      b.ttftSum += Number(row.avg_first_token_ms) * samples
      b.ttftN += samples
    }
    if (row.avg_duration_ms != null) {
      const samples = Number(row.ttft_samples || n) || n
      b.durSum += Number(row.avg_duration_ms) * samples
      b.durN += samples
    }
  }
  return MODEL_FAMILIES.map((f) => {
    const b = bag[f.id]
    return {
      model: f.label,
      requests: b.requests,
      errors: b.errors,
      avg_first_token_ms: b.ttftN ? Math.round(b.ttftSum / b.ttftN) : null,
      avg_duration_ms: b.durN ? Math.round(b.durSum / b.durN) : null,
    }
  })
}

/** 流量 · 首字延迟 + 模型分布。对齐 index.html 的 `renderTrafficOps(ops, {showModels})`. */
export function TrafficOps({
  ops,
  showModels = false,
}: {
  ops: OpsWindow | undefined
  showModels?: boolean
}) {
  const { t: translate } = useTranslation('overview')

  const o = ops && !ops.error ? ops : {}
  const sla = o.sla != null ? o.sla * 100 : null
  const err = o.error_rate != null ? o.error_rate * 100 : null
  const ttft = o.ttft || {}
  const dur = o.duration || {}
  const models = showModels ? opsModelFamilyRows(o.by_model || []) : []
  const streamPct = o.requests
    ? (((o.stream_requests || 0) / o.requests) * 100).toFixed(0)
    : null
  const hitPct =
    o.cache_hit_rate != null
      ? o.cache_hit_rate * 100
      : cacheHitPct(
          o.input_tokens,
          o.cache_read_tokens,
          o.cache_creation_tokens
        )
  const sticky = o.sticky || {}
  const stickyPct = sticky.rate != null ? sticky.rate * 100 : null

  if (ops?.error) {
    return (
      <p className='rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground'>
        {translate('overview:statsError', { error: ops.error })}
      </p>
    )
  }

  const cells: {
    label: string
    value: string
    hint?: string
    tone?: OpsTone
  }[] = [
    {
      label: translate('overview:successRate'),
      value: sla == null ? '—' : `${sla.toFixed(1)}%`,
      hint: translate('overview:requestSuccessSummary', {
        p0: fmtNum(o.success || 0),
        p1: fmtNum(o.requests || 0),
        p2: fmtNum(o.errors || 0),
      }),
      tone: slaTone(o.sla),
    },
    {
      label: translate('overview:errorRate'),
      value: err == null ? '—' : `${err.toFixed(1)}%`,
      hint: `429 ${fmtNum(o.status_429 || 0)} · 503 ${fmtNum(o.status_503 || 0)} · 529 ${fmtNum(o.status_529 || 0)}`,
      tone: errTone(o.error_rate),
    },
    {
      label: translate('overview:ttftMedian'),
      value: fmtMs(ttft.p50_ms),
      hint: translate('overview:averageSamples', {
        p0: fmtMs(ttft.avg_ms),
        p1: fmtNum(ttft.samples || 0),
      }),
      tone: ttftTone(ttft.p95_ms),
    },
    {
      label: translate('overview:ttftP95'),
      value: fmtMs(ttft.p95_ms),
      hint: translate('overview:p99AndMaximum', {
        p0: fmtMs(ttft.p99_ms),
        p1: fmtMs(ttft.max_ms),
      }),
      tone: ttftTone(ttft.p95_ms),
    },
    {
      label: translate('overview:durationMedian'),
      value: fmtMs(dur.p50_ms),
      hint: translate('overview:durationDistribution', {
        p95: fmtMs(dur.p95_ms),
        average: fmtMs(dur.avg_ms),
      }),
    },
    {
      label: 'QPS',
      value: fmtRate(o.qps?.avg),
      hint: translate('overview:currentAndPeak', {
        p0: fmtRate(o.qps?.current),
        p1: fmtRate(o.qps?.peak),
      }),
    },
    {
      label: 'TPS',
      value: fmtRate(o.tps?.avg, 1),
      hint: translate('overview:inputAndOutput', {
        p0: fmtNum(o.input_tokens || 0),
        p1: fmtNum(o.output_tokens || 0),
      }),
    },
    {
      label: translate('overview:streamingShare'),
      value: streamPct == null ? '—' : `${streamPct}%`,
      hint: translate('overview:streamingCount', {
        p0: fmtNum(o.stream_requests || 0),
      }),
    },
    {
      label: translate('overview:cacheHit'),
      value: hitPct == null ? '—' : fmtHitPct(hitPct),
      hint: translate('overview:cacheReadAndWrite', {
        p0: fmtNum(o.cache_read_tokens || 0),
        p1: fmtNum(o.cache_creation_tokens || 0),
      }),
    },
    {
      label: translate('overview:stickyScheduling'),
      value: stickyPct == null ? '—' : fmtHitPct(stickyPct),
      hint: translate('overview:stickySelections', {
        p0: fmtNum(sticky.hits || 0),
        p1: fmtNum(sticky.selections || 0),
      }),
    },
  ]

  return (
    <div className='space-y-3'>
      <PanelCard
        title={translate('overview:serviceQuality')}
        meta={translate('overview:lastHour')}
      >
        {/* 10 格：2 列与 5 列都整除，避免 gap-px 网格尾行漏底色。 */}
        <div className='grid grid-cols-2 gap-px bg-border/60 xl:grid-cols-5'>
          {cells.map((c) => (
            <StatCell
              key={c.label}
              label={c.label}
              value={c.value}
              hint={c.hint}
              valueClassName={TONE_TEXT[c.tone || 'neutral']}
            />
          ))}
        </div>
      </PanelCard>
      {models.length ? (
        <PanelCard
          title={translate('overview:modelFamily')}
          meta={translate('overview:lastHour')}
        >
          <div className='flex h-8 items-center bg-muted/30 px-4 text-[11px] font-medium text-muted-foreground/80'>
            <div className='flex-[2]'>{translate('overview:modelFamily')}</div>
            <div className='flex-1 text-right'>
              {translate('overview:requests')}
            </div>
            <div className='flex-1 text-right'>
              {translate('overview:errors')}
            </div>
            <div className='flex-1 text-right'>
              {translate('overview:averageTtft')}
            </div>
            <div className='flex-1 text-right'>
              {translate('overview:averageDuration')}
            </div>
          </div>
          {models.map((m) => (
            <div
              key={m.model}
              className='flex h-9 items-center border-t px-4 text-xs'
            >
              <div className='flex-[2] font-mono'>{m.model}</div>
              <div className='flex-1 text-right tabular-nums'>
                {fmtNum(m.requests)}
              </div>
              <div
                className='flex-1 text-right tabular-nums'
                style={m.errors ? { color: 'var(--status-bad)' } : undefined}
              >
                {fmtNum(m.errors)}
              </div>
              <div className='flex-1 text-right tabular-nums'>
                {fmtMs(m.avg_first_token_ms)}
              </div>
              <div className='flex-1 text-right tabular-nums'>
                {fmtMs(m.avg_duration_ms)}
              </div>
            </div>
          ))}
        </PanelCard>
      ) : null}
    </div>
  )
}

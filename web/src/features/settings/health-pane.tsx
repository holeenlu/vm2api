import { type ComponentProps, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  healthProbeQueryOptions,
  type HealthSnapshotView,
} from '@/features/settings/queries'
import { settleInt, typingInt } from './int-input'

type Obj = Record<string, unknown>

type HealthPaneProps = {
  title: string
  failover: Obj
  healthProbe: Obj | undefined
  compatibility: Obj
  onFailoverChange: (next: Obj) => void
  onHealthProbeChange: (next: Obj) => void
  onCompatibilityChange: (next: Obj) => void
}

function obj(value: unknown): Obj {
  return value && typeof value === 'object' ? (value as Obj) : {}
}

function clampInt(raw: string, min: number, max: number, fallback: number) {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 输入时不限范围（否则键入「120」第一个键就被拉成 30），失焦时再限到 [min, max]。
 * 未失焦直接保存时由网关按同样范围收口。
 */
function DeferredIntInput({
  value,
  min,
  max,
  fallback,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'> & {
  value: number
  min: number
  max: number
  fallback: number
  onCommit: (next: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      {...props}
      type='number'
      min={min}
      max={max}
      value={text ?? String(value)}
      onChange={(event) => {
        setText(event.target.value)
        const n = typingInt(event.target.value)
        if (n !== null) onCommit(n)
      }}
      onBlur={() => {
        if (text === null) return
        const settled = settleInt(text, min, max, fallback)
        setText(null)
        if (settled !== value) onCommit(settled)
      }}
    />
  )
}

export function HealthPane(props: HealthPaneProps) {
  const { t } = useTranslation('settings')

  const {
    title,
    failover,
    healthProbe,
    compatibility,
    onFailoverChange,
    onHealthProbeChange,
    onCompatibilityChange,
  } = props
  const probe = obj(healthProbe)
  const real = obj(probe.real)
  const minTokens = obj(compatibility.min_max_tokens)
  const setProbe = (patch: Obj) => onHealthProbeChange({ ...probe, ...patch })
  const setReal = (patch: Obj) => setProbe({ real: { ...real, ...patch } })
  const setMinTokens = (patch: Obj) =>
    onCompatibilityChange({
      ...compatibility,
      min_max_tokens: { enabled: true, value: 128, ...minTokens, ...patch },
    })

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className='text-xs text-muted-foreground'>
            {t('health.description')}
          </p>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label={t('health.interceptWarmup')}
            desc={t('health.warmupHelp')}
          >
            <Switch
              checked={probe.intercept_warmup === true}
              onCheckedChange={(checked) =>
                setProbe({ intercept_warmup: checked })
              }
              aria-label={t('health.interceptWarmup')}
            />
          </SettingRow>
          <SettingRow
            label={t('health.minimumTokens')}
            desc={t('health.minimumTokensHelp')}
          >
            <div className='flex items-center gap-3'>
              <Input
                className='w-24'
                type='number'
                min={1}
                max={4096}
                disabled={minTokens.enabled === false}
                value={Number(minTokens.value ?? 128)}
                onChange={(event) =>
                  setMinTokens({
                    value: clampInt(event.target.value, 1, 4096, 128),
                  })
                }
                aria-label={t('health.minimumTokens')}
              />
              <Switch
                checked={minTokens.enabled !== false}
                onCheckedChange={(checked) =>
                  setMinTokens({ enabled: checked })
                }
                aria-label={t('health.enableMinimum')}
              />
            </div>
          </SettingRow>
        </CardContent>
      </Card>
      <HealthCacheCard
        probe={probe}
        real={real}
        onProbeChange={setProbe}
        onRealChange={setReal}
      />
      <SignatureRepairCard failover={failover} onChange={onFailoverChange} />
    </>
  )
}

function HealthCacheCard({
  probe,
  real,
  onProbeChange,
  onRealChange,
}: {
  probe: Obj
  real: Obj
  onProbeChange: (patch: Obj) => void
  onRealChange: (patch: Obj) => void
}) {
  const { t } = useTranslation('settings')

  const status = useQuery(healthProbeQueryOptions())
  const snaps = status.data?.snapshots
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('health.cache')}</CardTitle>
        <p className='text-xs text-muted-foreground'>{t('health.cacheHelp')}</p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label={t('enable')} desc={t('health.disabledHint')}>
          <Switch
            checked={probe.enabled === true}
            onCheckedChange={(checked) => onProbeChange({ enabled: checked })}
            aria-label={t('health.enableCache')}
          />
        </SettingRow>
        <SettingRow
          label={t('health.probeInterval')}
          desc={t('health.intervalRange')}
        >
          <DeferredIntInput
            className='w-28'
            min={30}
            max={86400}
            fallback={600}
            value={Number(probe.interval_sec ?? 600)}
            onCommit={(next) => onProbeChange({ interval_sec: next })}
            aria-label={t('health.probeInterval')}
          />
        </SettingRow>
        <SettingRow
          label={t('health.probeAll')}
          desc={t('health.probeAllHelp')}
        >
          <Switch
            checked={probe.probe_all_slots === true}
            onCheckedChange={(checked) =>
              onProbeChange({ probe_all_slots: checked })
            }
            aria-label={t('health.probeAll')}
          />
        </SettingRow>
        <SettingRow
          label={t('health.cacheTtl')}
          desc={t('health.cacheTtlHelp')}
        >
          <DeferredIntInput
            className='w-28'
            min={30}
            max={172800}
            fallback={900}
            value={Number(probe.cache_ttl_sec ?? 900)}
            onCommit={(next) => onProbeChange({ cache_ttl_sec: next })}
            aria-label={t('health.cacheTtl')}
          />
        </SettingRow>
        <SettingRow
          label={t('health.claudeModel')}
          desc={t('health.claudeModelHelp')}
        >
          <Input
            className='w-56'
            value={String(real.model ?? 'claude-haiku-4-5')}
            onChange={(event) => onRealChange({ model: event.target.value })}
            aria-label={t('health.claudeModel')}
          />
        </SettingRow>
        <SettingRow
          label={t('health.gptModel')}
          desc={t('health.gptModelHelp')}
        >
          <Input
            className='w-56'
            placeholder={
              /* i18n-exempt "gpt-5.4" -- Example model ID; copying it must preserve the API identifier. */ 'gpt-5.4'
            }
            value={String(real.openai_model ?? '')}
            onChange={(event) =>
              onRealChange({ openai_model: event.target.value })
            }
            aria-label={t('health.gptModel')}
          />
        </SettingRow>
        <SettingRow label={t('health.latestSnapshot')}>
          <div className='flex flex-col items-end gap-1 text-xs'>
            <SnapshotLine label='Claude' snap={snaps?.anthropic} />
            <SnapshotLine label='GPT' snap={snaps?.openai} />
          </div>
        </SettingRow>
      </CardContent>
    </Card>
  )
}

function SnapshotLine({
  label,
  snap,
}: {
  label: string
  snap: HealthSnapshotView | undefined
}) {
  const { t } = useTranslation('settings')

  if (!snap?.at) {
    return (
      <span className='text-muted-foreground'>
        {t('health.noSnapshot', { value1: label })}
      </span>
    )
  }
  const tone = snap.ok ? 'default' : snap.error ? 'destructive' : 'secondary'
  const text = snap.ok
    ? t('available')
    : snap.error
      ? t('failed')
      : t('expired')
  return (
    <span className='flex items-center gap-2'>
      <span className='text-muted-foreground'>
        {label} · {snap.vm_id || '—'} · {snap.model || '—'}
      </span>
      <Badge variant={tone} title={snap.error || undefined}>
        {text}
      </Badge>
    </span>
  )
}

function SignatureRepairCard({
  failover,
  onChange,
}: {
  failover: Obj
  onChange: (next: Obj) => void
}) {
  const { t } = useTranslation('settings')

  // 默认值在 gateway HEAD 与工作区之间相反（!== false vs === true），
  // 所以不硬编码默认态，严格按 GET /routing 的实际值回显。
  const enabled = failover.signature_repair === true
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('health.signatureRepair')}</CardTitle>
      </CardHeader>
      <CardContent className='flex items-start justify-between gap-4'>
        <div className='space-y-1 text-sm text-muted-foreground'>
          <p>{t('health.signatureRepairHelp')}</p>
          <p>{t('health.signatureDisabledHelp')}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            onChange({ ...failover, signature_repair: checked })
          }
          aria-label={t('health.signatureRepair')}
        />
      </CardContent>
    </Card>
  )
}

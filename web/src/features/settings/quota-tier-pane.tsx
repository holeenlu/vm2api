import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type { QuotaTierKey, QuotaTierPolicy } from '@/types/panel-vm'
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Gauge,
  Info,
  ServerCog,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  CONC_STEPS,
  RPM_STEPS,
  withCurrent,
} from '@/features/vm/scheduling-steps'
import {
  PlatformAccountList,
  QuotaSummary,
  RatioSetting,
} from './quota-controls'
import {
  type Obj,
  formatRpm,
  numberOf,
  quotaDialogClass,
  recordOf,
} from './quota-values'
import {
  ChipGroup,
  PaneSection,
  SliderSetting,
  StepperSetting,
} from './scheduler-controls'

type DialogKind = 'gates' | 'concurrency' | 'rpm' | 'details'

function getTiers(): { key: QuotaTierKey; label: string; hint: string }[] {
  return [
    {
      key: 'default',
      label: translate('settings:default'),
      hint: translate('settings:quota.defaultTierHelp'),
    },
    {
      key: 'pro',
      label: 'Pro',
      hint: translate('settings:quota.standardTierHelp'),
    },
    {
      key: 'max',
      label: 'Max',
      hint: translate('settings:quota.fableTierHelp'),
    },
  ]
}

const TIER_DEFAULTS: Record<
  QuotaTierKey,
  {
    max_concurrency: number
    max_rpm: number
    limit_5h: number
    limit_7d: number
  }
> = {
  default: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  pro: { max_concurrency: 2, max_rpm: 0, limit_5h: 0.85, limit_7d: 0.8 },
  max: { max_concurrency: 4, max_rpm: 0, limit_5h: 0.95, limit_7d: 0.95 },
}

function cloneTiers(
  source: Record<string, QuotaTierPolicy>
): Record<QuotaTierKey, QuotaTierPolicy> {
  return Object.fromEntries(
    getTiers().map(({ key }) => [key, { ...(source[key] || {}) }])
  ) as Record<QuotaTierKey, QuotaTierPolicy>
}

function ratioValue(
  policy: QuotaTierPolicy,
  key: 'limit_5h' | 'limit_7d',
  fallback: number
) {
  return numberOf(policy[key], fallback) * 100
}

function tierSummary(
  tiers: Record<string, QuotaTierPolicy>,
  format: (policy: QuotaTierPolicy, key: QuotaTierKey) => string
) {
  return getTiers()
    .map(({ key, label }) => `${label} ${format(tiers[key] || {}, key)}`)
    .join(' · ')
}

function TierTabs({
  tier,
  onTier,
}: {
  tier: QuotaTierKey
  onTier: (next: QuotaTierKey) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className='space-y-2'>
      <div className='text-xs font-medium'>{t('quota.accountTier')}</div>
      <div
        className='flex flex-wrap gap-2'
        role='tablist'
        aria-label={t('quota.accountTier')}
      >
        {getTiers().map((item) => (
          <Button
            key={item.key}
            type='button'
            size='sm'
            variant={item.key === tier ? 'default' : 'outline'}
            role='tab'
            aria-selected={item.key === tier}
            className='min-h-11'
            onClick={() => onTier(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <p className='text-xs text-muted-foreground'>
        {getTiers().find((item) => item.key === tier)?.hint}
      </p>
    </div>
  )
}

function ClaudeGates({
  tier,
  tiers,
  quota,
  weeklyExpanded,
  onTier,
  onTierChange,
  onQuotaChange,
  onWeeklyExpanded,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  quota: Obj
  weeklyExpanded: boolean
  onTier: (next: QuotaTierKey) => void
  onTierChange: (patch: QuotaTierPolicy) => void
  onQuotaChange: (patch: Obj) => void
  onWeeklyExpanded: (next: boolean) => void
}) {
  const { t } = useTranslation('settings')

  const policy = tiers[tier] || {}
  const fallback = TIER_DEFAULTS[tier]
  const weekly = recordOf(quota.weekly_split)
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <div className='grid gap-4 sm:grid-cols-2'>
        <RatioSetting
          id={`claude-${tier}-5h`}
          label={t('quota.fiveHourThreshold')}
          value={numberOf(policy.limit_5h, fallback.limit_5h)}
          fallback={fallback.limit_5h}
          onChange={(value) => onTierChange({ limit_5h: value })}
        />
        <RatioSetting
          id={`claude-${tier}-7d`}
          label={t('quota.sevenDayThreshold')}
          value={numberOf(policy.limit_7d, fallback.limit_7d)}
          fallback={fallback.limit_7d}
          onChange={(value) => onTierChange({ limit_7d: value })}
        />
      </div>
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
          <Label>{t('quota.fiveHourEnabled')}</Label>
          <Switch
            checked={quota.block_on_5h !== false}
            onCheckedChange={(block_on_5h) => onQuotaChange({ block_on_5h })}
          />
        </div>
        <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
          <Label>{t('quota.sevenDayEnabled')}</Label>
          <Switch
            checked={quota.block_on_7d !== false}
            onCheckedChange={(block_on_7d) => onQuotaChange({ block_on_7d })}
          />
        </div>
      </div>
      <div className='space-y-3 rounded-lg border p-3'>
        <SliderSetting
          id='claude-gate-overshoot'
          label={t('quota.overrun')}
          desc={t('quota.overrunHelp')}
          value={Math.round(numberOf(quota.gate_overshoot, 0.05) * 100)}
          min={0}
          max={10}
          step={1}
          format={(value) => `${value}%`}
          fallback={5}
          presets={[0, 3, 5]}
          onChange={(value) => onQuotaChange({ gate_overshoot: value / 100 })}
        />
      </div>
      <div className='space-y-3 rounded-lg border p-3'>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <Label>{t('quota.coldRequestProtection')}</Label>
            <p className='text-xs text-muted-foreground'>
              {t('quota.coldRequestHelp')}
            </p>
          </div>
          <Switch
            checked={quota.guard_large_cold !== false}
            onCheckedChange={(guard_large_cold) =>
              onQuotaChange({ guard_large_cold })
            }
          />
        </div>
        <SliderSetting
          id='claude-critical-band'
          label={t('quota.criticalBand')}
          desc={t('quota.criticalBandHelp')}
          value={Math.round(numberOf(quota.critical_band, 0.05) * 100)}
          min={1}
          max={15}
          step={1}
          format={(value) => `${value}%`}
          fallback={5}
          presets={[3, 5, 10]}
          onChange={(value) => onQuotaChange({ critical_band: value / 100 })}
        />
        <StepperSetting
          id='claude-large-cold-tokens'
          label={t('quota.coldThreshold')}
          desc={t('quota.coldThresholdHelp')}
          value={Math.round(
            numberOf(quota.large_cold_uncached_tokens, 100000) / 1000
          )}
          min={20}
          max={500}
          step={10}
          unit='k'
          fallback={100}
          onChange={(value) =>
            onQuotaChange({
              large_cold_uncached_tokens: Math.round(value) * 1000,
            })
          }
        />
      </div>
      <div className='rounded-lg border'>
        <button
          type='button'
          className='flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left'
          aria-expanded={weeklyExpanded}
          onClick={() => onWeeklyExpanded(!weeklyExpanded)}
        >
          <span>
            <span className='block text-sm font-medium'>
              {t('quota.weeklySplit')}
            </span>
            <span className='block text-xs text-muted-foreground'>
              {t('quota.weeklySplitHelp')}
            </span>
          </span>
          {weeklyExpanded ? (
            <ChevronDown className='size-4 shrink-0' aria-hidden />
          ) : (
            <ChevronRight className='size-4 shrink-0' aria-hidden />
          )}
        </button>
        {weeklyExpanded ? (
          <div className='space-y-3 border-t px-3 py-3'>
            <div className='flex items-center justify-between gap-4'>
              <div>
                <Label>{t('quota.enableWeeklySplit')}</Label>
                <p className='text-xs text-muted-foreground'>
                  {t('quota.weeklyShareHelp')}
                </p>
              </div>
              <Switch
                checked={weekly.enabled === true}
                onCheckedChange={(enabled) =>
                  onQuotaChange({
                    weekly_split: { ...weekly, enabled },
                  })
                }
              />
            </div>
            <SliderSetting
              id='claude-weekly-fable-share'
              label={t('quota.fableShare')}
              value={numberOf(weekly.fable_share, 0.5) * 100}
              min={0}
              max={100}
              step={5}
              format={(value) => `${value}%`}
              fallback={50}
              presets={[25, 50, 75]}
              onChange={(value) =>
                onQuotaChange({
                  weekly_split: { ...weekly, fable_share: value / 100 },
                })
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ClaudeConcurrency({
  tier,
  tiers,
  onTier,
  onChange,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  onTier: (next: QuotaTierKey) => void
  onChange: (patch: QuotaTierPolicy) => void
}) {
  const { t } = useTranslation('settings')

  const policy = tiers[tier] || {}
  const value = numberOf(
    policy.max_concurrency,
    TIER_DEFAULTS[tier].max_concurrency
  )
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <StepperSetting
        id={`claude-${tier}-concurrency`}
        label={t('quota.concurrency')}
        desc={t('quota.claudeConcurrencyHelp')}
        value={value}
        min={1}
        max={256}
        fallback={TIER_DEFAULTS[tier].max_concurrency}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
      <ChipGroup
        label={t('quota.claudeConcurrencyPresets')}
        value={value}
        options={withCurrent(
          CONC_STEPS.filter(([next]) => next > 0),
          value
        )}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
    </div>
  )
}

function ClaudeRpm({
  tier,
  tiers,
  onTier,
  onChange,
}: {
  tier: QuotaTierKey
  tiers: Record<QuotaTierKey, QuotaTierPolicy>
  onTier: (next: QuotaTierKey) => void
  onChange: (patch: QuotaTierPolicy) => void
}) {
  const { t } = useTranslation('settings')

  const policy = tiers[tier] || {}
  const value = numberOf(policy.max_rpm, TIER_DEFAULTS[tier].max_rpm)
  return (
    <div className='space-y-4'>
      <TierTabs tier={tier} onTier={onTier} />
      <StepperSetting
        id={`claude-${tier}-rpm`}
        label={t('quota.requestRate')}
        desc={t('quota.rpmHelp')}
        value={value}
        min={0}
        max={1000000}
        unit='RPM'
        fallback={TIER_DEFAULTS[tier].max_rpm}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
      <ChipGroup
        label={t('quota.claudeRpmPresets')}
        value={value}
        options={withCurrent(RPM_STEPS, value)}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
    </div>
  )
}

export function QuotaTierPane({
  tiers,
  quota,
  onChange,
  onQuotaChange,
  saving = false,
  pending = false,
}: {
  tiers: Record<string, QuotaTierPolicy>
  quota: Obj
  onChange: (tier: QuotaTierKey, patch: QuotaTierPolicy) => void
  onQuotaChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('settings')

  const list = useQuery(vmsListQueryOptions(5000))
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [tier, setTier] = useState<QuotaTierKey>('default')
  const [draftTiers, setDraftTiers] = useState<
    Record<QuotaTierKey, QuotaTierPolicy>
  >(cloneTiers(tiers))
  const [draftQuota, setDraftQuota] = useState<Obj>({ ...quota })
  const [weeklyExpanded, setWeeklyExpanded] = useState(false)
  const triggerRefs = useRef<
    Partial<Record<DialogKind, HTMLButtonElement | null>>
  >({})
  const previousDialog = useRef<DialogKind | null>(null)

  useEffect(() => {
    if (previousDialog.current && !dialog) {
      triggerRefs.current[previousDialog.current]?.focus()
    }
    previousDialog.current = dialog
  }, [dialog])

  const openDialog = (kind: DialogKind) => {
    if (saving) return
    setDraftTiers(cloneTiers(tiers))
    setDraftQuota({ ...quota })
    setTier('default')
    setWeeklyExpanded(false)
    setDialog(kind)
  }
  const closeDialog = () => {
    if (!saving) setDialog(null)
  }
  const apply = () => {
    if (!dialog || saving) return
    if (dialog === 'details') {
      closeDialog()
      return
    }
    if (dialog === 'gates') {
      getTiers().forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          limit_5h: numberOf(policy.limit_5h, TIER_DEFAULTS[key].limit_5h),
          limit_7d: numberOf(policy.limit_7d, TIER_DEFAULTS[key].limit_7d),
        })
      })
      const weekly = recordOf(draftQuota.weekly_split)
      onQuotaChange({
        block_on_5h: draftQuota.block_on_5h !== false,
        block_on_7d: draftQuota.block_on_7d !== false,
        guard_large_cold: draftQuota.guard_large_cold !== false,
        critical_band: Math.min(
          0.15,
          Math.max(0.01, numberOf(draftQuota.critical_band, 0.05))
        ),
        gate_overshoot: Math.min(
          0.1,
          Math.max(0, numberOf(draftQuota.gate_overshoot, 0.05))
        ),
        large_cold_uncached_tokens: Math.min(
          500000,
          Math.max(
            20000,
            Math.round(numberOf(draftQuota.large_cold_uncached_tokens, 100000))
          )
        ),
        weekly_split: {
          ...weekly,
          enabled: weekly.enabled === true,
          fable_share: numberOf(weekly.fable_share, 0.5),
        },
      })
    } else if (dialog === 'concurrency') {
      getTiers().forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          max_concurrency: numberOf(
            policy.max_concurrency,
            TIER_DEFAULTS[key].max_concurrency
          ),
        })
      })
    } else if (dialog === 'rpm') {
      getTiers().forEach(({ key }) => {
        const policy = draftTiers[key] || {}
        onChange(key, {
          max_rpm: numberOf(policy.max_rpm, TIER_DEFAULTS[key].max_rpm),
        })
      })
    }
    setDialog(null)
  }

  const claudeItems = (list.data?.items || []).filter((vm) => !isCodexVm(vm))
  const title =
    dialog === 'gates'
      ? t('quota.gates')
      : dialog === 'concurrency'
        ? t('quota.concurrency')
        : dialog === 'rpm'
          ? t('quota.requestRate')
          : t('quota.accountOverrides')

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={Gauge}
        title={t('quota.claudeTitle')}
        desc={t('quota.accountCount', { value1: claudeItems.length })}
      >
        <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3'>
          <QuotaSummary
            icon={Clock3}
            title={t('quota.gates')}
            value={tierSummary(tiers, (policy, key) => {
              const fallback = TIER_DEFAULTS[key]
              return `${Math.round(ratioValue(policy, 'limit_5h', fallback.limit_5h))}% / ${Math.round(ratioValue(policy, 'limit_7d', fallback.limit_7d))}%`
            })}
            desc={t('quota.localSoftGate')}
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.gates = node
            }}
            disabled={saving}
            onClick={() => openDialog('gates')}
          />
          <QuotaSummary
            icon={ServerCog}
            title={t('quota.concurrency')}
            value={tierSummary(
              tiers,
              (policy, key) =>
                `${numberOf(policy.max_concurrency, TIER_DEFAULTS[key].max_concurrency)}`
            )}
            desc={t('quota.inflightPerAccount')}
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.concurrency = node
            }}
            disabled={saving}
            onClick={() => openDialog('concurrency')}
          />
          <QuotaSummary
            icon={Gauge}
            title={t('quota.requestRate')}
            value={tierSummary(tiers, (policy, key) =>
              formatRpm(numberOf(policy.max_rpm, TIER_DEFAULTS[key].max_rpm))
            )}
            desc={t('quota.queueNotSwitch')}
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.rpm = node
            }}
            disabled={saving}
            onClick={() => openDialog('rpm')}
          />
        </div>
        <Button
          ref={(node) => {
            triggerRefs.current.details = node
          }}
          type='button'
          variant='ghost'
          disabled={saving}
          className='mt-3 h-auto min-h-11 w-full items-start justify-start gap-2 px-2 py-3 text-left whitespace-normal'
          onClick={() => openDialog('details')}
        >
          <Info className='size-4 text-muted-foreground' aria-hidden />
          <span className='min-w-0 flex-1'>
            <span className='block text-sm font-medium'>
              {t('quota.accountOverrides')}
            </span>
            <span className='block text-xs font-normal text-muted-foreground'>
              {t('quota.accountOverridesHelp')}
            </span>
          </span>
        </Button>
      </PaneSection>

      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !saving) closeDialog()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className={quotaDialogClass(dialog ?? '', dialog === 'gates')}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{t('quota.draftHelp')}</DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {dialog === 'gates' ? (
              <ClaudeGates
                tier={tier}
                tiers={draftTiers}
                quota={draftQuota}
                weeklyExpanded={weeklyExpanded}
                onTier={setTier}
                onTierChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
                onQuotaChange={(patch) =>
                  setDraftQuota((current) => ({
                    ...current,
                    ...patch,
                  }))
                }
                onWeeklyExpanded={setWeeklyExpanded}
              />
            ) : null}
            {dialog === 'concurrency' ? (
              <ClaudeConcurrency
                tier={tier}
                tiers={draftTiers}
                onTier={setTier}
                onChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
              />
            ) : null}
            {dialog === 'rpm' ? (
              <ClaudeRpm
                tier={tier}
                tiers={draftTiers}
                onTier={setTier}
                onChange={(patch) =>
                  setDraftTiers((current) => ({
                    ...current,
                    [tier]: { ...current[tier], ...patch },
                  }))
                }
              />
            ) : null}
            {dialog === 'details' ? (
              <PlatformAccountList
                platform='claude'
                items={claudeItems}
                loading={list.isLoading}
                error={list.error}
              />
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={closeDialog}
            >
              {dialog === 'details' ? t('off') : t('cancel')}
            </Button>
            {dialog !== 'details' ? (
              <Button
                type='button'
                disabled={saving}
                className='min-h-11'
                onClick={apply}
              >
                {t('applyDraft')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { t as translate } from '@/i18n'
import {
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_MAX,
  SESSION_IDLE_TTL_SECONDS_MIN,
} from '@/types/panel-routing'
import {
  Brain,
  Check,
  Clock3,
  Database,
  Scaling,
  ShieldCheck,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  cacheTtlFromCompat,
  detectProxiedOfficialCcFromCompat,
} from '@/lib/cache-breakpoints'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  cchEnabledFromCompat,
  sessionIdleTtlFromInference,
  thinkingDisplayFromCompat,
} from './protocol-authority'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type Block = Record<string, unknown>

/** Mirrors `hasClaudeCodeClientHeaders` + body checks in src/lib/identity/claude-code-only.mjs. */
function getClaudeCodeFingerprint(): [string, string][] {
  return [
    ['UA', 'claude-cli/x.y.z'],
    ['x-app', 'cli'],
    ['anthropic-beta', 'claude-code-20250219'],
    ['Stainless SDK', 'x-stainless-lang: js'],
    [translate('settings:protocol.sessionHeader'), '= user_id.session_id'],
    ['system', translate('settings:protocol.billingIdentity')],
    [
      translate('settings:protocol.billingBlock'),
      translate('settings:protocol.versionMatch'),
    ],
  ]
}

function autoCompactWindowValue(value: unknown) {
  const tokens = Number(value)
  if (tokens === 200_000 || tokens === 500_000 || tokens === 1_000_000)
    return String(tokens)
  return 'model'
}

export function ProtocolPane({
  compat,
  inference,
  onCompatChange,
  onInferenceChange,
}: {
  compat: Block
  inference: Block
  onCompatChange: (next: Block) => void
  onInferenceChange: (patch: Block) => void
}) {
  const { t } = useTranslation('settings')

  const strict = compat.claude_code_only === true
  const relay = detectProxiedOfficialCcFromCompat(compat)
  const cch = cchEnabledFromCompat(compat)
  return (
    <div className='space-y-4'>
      <PaneSection
        icon={ShieldCheck}
        title={t('protocol.inboundAccess')}
        desc={t('protocol.accessHelp')}
        aside={
          <Badge variant={strict ? 'default' : 'secondary'}>
            {strict ? t('protocol.claudeCodeOnly') : t('protocol.anyClient')}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label={t('protocol.allowClaudeCode')}
            desc={t('protocol.rejectOtherClients')}
          >
            <Switch
              checked={strict}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, claude_code_only: on })
              }
              aria-label={t('protocol.allowClaudeCode')}
            />
          </SettingRow>
          <SettingRow
            label={t('protocol.detectProxied')}
            desc={
              relay
                ? t('protocol.detectProxiedHelp')
                : t('protocol.detectDisabled')
            }
          >
            <Switch
              checked={relay}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, detect_proxied_official_cc: on })
              }
              aria-label={t('protocol.detectProxied')}
            />
          </SettingRow>
          <SettingRow
            label={t('protocol.officialPassthrough')}
            desc={
              compat.official_cc_passthrough === true
                ? t('protocol.passthroughEnabled')
                : t('protocol.passthroughDisabled')
            }
          >
            <Switch
              checked={compat.official_cc_passthrough === true}
              onCheckedChange={(on) =>
                onCompatChange({ ...compat, official_cc_passthrough: on })
              }
              aria-label={t('protocol.officialPassthrough')}
            />
          </SettingRow>
        </div>
        <div
          className={cn(
            'space-y-3 pt-3 transition-opacity duration-200',
            !strict && 'opacity-55'
          )}
        >
          <p className='text-xs text-muted-foreground'>
            {strict
              ? t('protocol.directRequirements')
              : t('protocol.enabledRequirements')}
          </p>
          <ul className='grid gap-x-4 gap-y-1.5 sm:grid-cols-2'>
            {getClaudeCodeFingerprint().map(([name, value]) => (
              <li key={name} className='flex min-w-0 items-start gap-2 text-xs'>
                <Check
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    strict ? 'text-primary' : 'text-muted-foreground'
                  )}
                  aria-hidden
                />
                <span className='min-w-0'>
                  <span className='font-medium'>{name}</span>{' '}
                  <span className='font-mono break-all text-muted-foreground'>
                    {value}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className='text-xs leading-5 text-muted-foreground'>
            {t('protocol.requirementsHelp')}
          </p>
        </div>
      </PaneSection>
      <PaneSection
        icon={Database}
        title={t('promptCache')}
        desc={t('protocol.cacheHelp')}
      >
        <SettingRow
          label={t('protocol.defaultCacheTtl')}
          desc={t('protocol.cachePriority')}
        >
          <ChipGroup
            label={t('protocol.defaultCacheTtl')}
            value={cacheTtlFromCompat(compat)}
            options={[
              ['5m', t('protocol.fiveMinutes')],
              ['1h', t('protocol.oneHour')],
            ]}
            onChange={(cache_ttl) => onCompatChange({ ...compat, cache_ttl })}
          />
        </SettingRow>
        <p className='text-xs leading-5 text-muted-foreground'>
          {t('protocol.cacheSaveHelp')}
        </p>
      </PaneSection>
      <PaneSection
        icon={Brain}
        title={t('protocol.thinkingDisplay')}
        desc={t('protocol.thinkingHelp')}
      >
        <SettingRow
          label={t('protocol.summarizeHidden')}
          desc={
            thinkingDisplayFromCompat(compat) === 'summarized'
              ? t('protocol.summarizeEnabled')
              : t('protocol.summarizeDisabled')
          }
        >
          <Switch
            checked={thinkingDisplayFromCompat(compat) === 'summarized'}
            onCheckedChange={(on) =>
              onCompatChange({
                ...compat,
                thinking_display: on ? 'summarized' : 'passthrough',
              })
            }
            aria-label={t('protocol.summarizeHidden')}
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Scaling}
        title={t('protocol.compactWindow')}
        desc={t('protocol.compactHelp')}
      >
        <SettingRow
          label={t('protocol.window')}
          desc={t('protocol.modelWindowHelp')}
        >
          <ChipGroup
            label={t('protocol.compactWindow')}
            value={autoCompactWindowValue(compat.auto_compact_window)}
            options={[
              ['model', t('protocol.followModel')],
              ['200000', '200K'],
              ['500000', '500K'],
              ['1000000', '1M'],
            ]}
            onChange={(value) =>
              onCompatChange({
                ...compat,
                auto_compact_window: value === 'model' ? null : Number(value),
              })
            }
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title={t('protocol.cch')}
        desc={t('protocol.cchHelp')}
      >
        <SettingRow
          label={t('protocol.forceCch')}
          desc={cch ? t('protocol.cchEnabled') : t('protocol.cchDisabled')}
        >
          <Switch
            checked={cch}
            onCheckedChange={(on) =>
              onCompatChange({ ...compat, cch_enabled: on })
            }
            aria-label={t('protocol.forceCch')}
          />
        </SettingRow>
      </PaneSection>
      <PaneSection
        icon={Clock3}
        title={t('protocol.nativeSticky')}
        desc={t('protocol.nativeStickyHelp')}
      >
        <StepperSetting
          id='inference-session-idle-ttl'
          label={t('protocol.slotIdleTimeout')}
          desc={t('protocol.slotIdleHelp')}
          value={sessionIdleTtlFromInference(inference)}
          min={SESSION_IDLE_TTL_SECONDS_MIN}
          max={SESSION_IDLE_TTL_SECONDS_MAX}
          unit={t('secondsUnit')}
          fallback={SESSION_IDLE_TTL_SECONDS_DEFAULT}
          onChange={(value) =>
            onInferenceChange({ session_idle_ttl_seconds: value })
          }
        />
      </PaneSection>
    </div>
  )
}

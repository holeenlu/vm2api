import { t as translate } from '@/i18n'
import type { OpenAIQuotaPolicy } from '@/types/panel-vm'
import { Fingerprint, ShieldCheck, Waypoints } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import { CodexSchedulingSection } from './codex-scheduling-section'
import { OpenaiQuotaSection } from './openai-quota-section'
import { ChipGroup, PaneSection } from './scheduler-controls'

type Block = Record<string, unknown>
type Transport = 'prefer_websocket' | 'http'

const DEFAULT_USER_AGENT = 'codex_cli_rs/0.160.0 (linux x86_64)'
function getTransportOptions(): [Transport, string][] {
  return [
    ['prefer_websocket', translate('settings:openai.preferWebSocket')],
    ['http', translate('settings:openai.httpOnly')],
  ]
}

function asBlock(value: unknown): Block {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Block)
    : {}
}

function codexClient(codex: Block, key: string) {
  const clients = asBlock(codex.clients)
  return clients[key] === 'allow'
}

export function OpenaiPane({
  websocket,
  codex,
  onWebsocketChange,
  onCodexChange,
  saving = false,
  pending = false,
}: {
  websocket: Block
  codex: Block
  onWebsocketChange: (next: Block) => void
  onCodexChange: (next: Block) => void
  saving?: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('settings')

  const routeOn = codex.enabled !== false
  const globalWs = asBlock(websocket).enabled !== false
  const gptWs = asBlock(codex.websocket).enabled !== false
  const wsLive = globalWs && gptWs
  const features = asBlock(codex.client_features)
  const analytics = asBlock(codex.analytics)
  const convert = asBlock(codex.convert)
  const transport: Transport =
    codex.upstream_transport === 'http' ? 'http' : 'prefer_websocket'
  const quota = asBlock(codex.quota) as Partial<OpenAIQuotaPolicy>
  const responsesOn =
    asBlock(asBlock(codex.protocols)['openai.responses']).enabled !== false

  const update = (patch: Block) => onCodexChange({ ...codex, ...patch })
  const setClient = (key: string, allow: boolean) =>
    update({
      clients: {
        ...asBlock(codex.clients),
        [key]: allow ? 'allow' : 'reject',
      },
    })

  return (
    <div className='space-y-4'>
      <PaneSection
        icon={Waypoints}
        title={t('openai.transport')}
        desc={t('openai.transportHelp')}
        aside={
          <Badge variant={wsLive ? 'default' : 'secondary'}>
            {wsLive ? t('openai.wsEnabled') : t('openai.forcedHttp')}
          </Badge>
        }
      >
        <div className='divide-y'>
          <SettingRow
            label={t('openai.globalWebSocket')}
            desc={t('openai.globalWebSocketHelp')}
          >
            <Switch
              checked={globalWs}
              disabled={saving}
              onCheckedChange={(enabled) =>
                onWebsocketChange({ ...websocket, enabled })
              }
              aria-label={t('openai.globalWebSocket')}
            />
          </SettingRow>
          <SettingRow
            label='GPT WebSocket'
            desc={
              globalWs
                ? t('openai.gptWebSocketHelp')
                : t('openai.globalDisabledHint')
            }
          >
            <Switch
              checked={gptWs}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  websocket: { ...asBlock(codex.websocket), enabled },
                })
              }
              aria-label='GPT WebSocket'
            />
          </SettingRow>
          <SettingRow
            label={t('openai.upstreamTransport')}
            desc={
              wsLive
                ? t('openai.upstreamTransportHelp')
                : t('openai.transportPreserved', {
                    value1: t(
                      transport === 'http'
                        ? 'openai.httpOnly'
                        : 'openai.preferWebSocket'
                    ),
                  })
            }
          >
            <ChipGroup
              label={t('openai.upstreamTransport')}
              value={transport}
              options={getTransportOptions()}
              disabled={saving || !wsLive}
              onChange={(upstream_transport) => update({ upstream_transport })}
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldCheck}
        title={t('openai.access')}
        desc={routeOn ? t('openai.accessHelp') : t('openai.routingDisabled')}
        aside={
          <Switch
            checked={routeOn}
            disabled={saving}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label={t('openai.enableRouting')}
          />
        }
      >
        <div
          className={cn(
            'space-y-6 transition-opacity duration-200',
            !routeOn && 'opacity-55'
          )}
        >
          <section className='min-w-0 space-y-2'>
            <h4 className='text-xs font-medium text-muted-foreground'>
              {t('openai.clients')}
            </h4>
            <div className='divide-y'>
              <SettingRow label={t('openai.officialClients')}>
                <Switch
                  checked={codexClient(codex, 'official_codex')}
                  disabled={saving}
                  onCheckedChange={(allow) =>
                    setClient('official_codex', allow)
                  }
                  aria-label={t('openai.allowOfficial')}
                />
              </SettingRow>
              <SettingRow label={t('openai.compatibleClients')}>
                <Switch
                  checked={codexClient(codex, 'openai_compatible')}
                  disabled={saving}
                  onCheckedChange={(allow) =>
                    setClient('openai_compatible', allow)
                  }
                  aria-label={t('openai.allowCompatible')}
                />
              </SettingRow>
              <SettingRow
                label={t('openai.rejectClaudeCode')}
                desc={t('openai.claudeCodeHelp')}
              >
                <Switch
                  checked={!codexClient(codex, 'claude_code')}
                  disabled={saving}
                  onCheckedChange={(reject) =>
                    setClient('claude_code', !reject)
                  }
                  aria-label={t('openai.rejectClaudeCodeModels')}
                />
              </SettingRow>
            </div>
          </section>
          <section className='min-w-0 space-y-2'>
            <h4 className='text-xs font-medium text-muted-foreground'>
              {t('openai.entryPoints')}
            </h4>
            <div className='divide-y'>
              <SettingRow
                label='/v1/responses'
                desc={t('openai.nativeResponses')}
              >
                <Switch
                  checked={responsesOn}
                  disabled={saving}
                  onCheckedChange={(on) =>
                    update({
                      protocols: {
                        ...asBlock(codex.protocols),
                        'openai.responses': { mode: 'native', enabled: on },
                      },
                    })
                  }
                  aria-label='/v1/responses'
                />
              </SettingRow>
              <SettingRow label={t('openai.chatToResponses')}>
                <Switch
                  checked={convert.chat_to_codex !== false}
                  disabled={saving}
                  onCheckedChange={(chat_to_codex) =>
                    update({ convert: { ...convert, chat_to_codex } })
                  }
                  aria-label={t('openai.chatToResponses')}
                />
              </SettingRow>
              <SettingRow label={t('openai.completionsToCodex')}>
                <Switch
                  checked={convert.completions_to_codex !== false}
                  disabled={saving}
                  onCheckedChange={(completions_to_codex) =>
                    update({
                      convert: { ...convert, completions_to_codex },
                    })
                  }
                  aria-label={t('openai.completionsToCodex')}
                />
              </SettingRow>
            </div>
          </section>
        </div>
      </PaneSection>

      <CodexSchedulingSection
        value={asBlock(codex.scheduling)}
        disabled={saving || pending}
        onChange={(scheduling) => update({ scheduling })}
      />

      <OpenaiQuotaSection
        quota={quota}
        saving={saving}
        pending={pending}
        onChange={(patch) =>
          update({
            quota: {
              ...asBlock(codex.quota),
              ...patch,
            },
          })
        }
      />

      <PaneSection
        icon={Fingerprint}
        title={t('openai.clientProfile')}
        desc={t('openai.clientProfileHelp')}
      >
        <div className='divide-y'>
          <SettingRow
            label={t('openai.installationMetadata')}
            desc={t('openai.installationMetadataHelp')}
          >
            <Switch
              checked={features.enabled === true}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  client_features: { ...features, enabled },
                })
              }
              aria-label={t('openai.installationMetadata')}
            />
          </SettingRow>
          <SettingRow
            label={t('openai.environmentAnalytics')}
            desc={t('openai.environmentAnalyticsHelp')}
          >
            <Switch
              checked={analytics.enabled === true}
              disabled={saving}
              onCheckedChange={(enabled) =>
                update({
                  analytics: { ...analytics, enabled },
                })
              }
              aria-label={t('openai.environmentAnalytics')}
            />
          </SettingRow>
          <SettingRow
            label={t('openai.catalogVersion')}
            desc={t('openai.catalogVersionHelp')}
          >
            <Input
              className='w-28'
              maxLength={20}
              value={String(codex.catalog_client_version ?? 'auto')}
              placeholder={
                /* i18n-exempt "auto" -- Literal catalog_client_version auto sentinel; sent to the API unchanged. */ 'auto'
              }
              disabled={saving}
              aria-label={t('openai.catalogVersion')}
              onChange={(e) =>
                update({
                  catalog_client_version: e.target.value || 'auto',
                })
              }
            />
          </SettingRow>
          <div className='space-y-2 py-3'>
            <div className='space-y-0.5'>
              <Label htmlFor='codex-user-agent'>{t('openai.userAgent')}</Label>
              <p className='text-xs text-muted-foreground'>
                {t('openai.userAgentHelp', { value1: DEFAULT_USER_AGENT })}
              </p>
            </div>
            <Input
              id='codex-user-agent'
              className='w-full min-w-0 font-mono text-xs'
              value={String(codex.user_agent ?? DEFAULT_USER_AGENT)}
              placeholder={DEFAULT_USER_AGENT}
              disabled={saving}
              spellCheck={false}
              autoComplete='off'
              aria-label={t('openai.userAgent')}
              onChange={(e) =>
                update({ user_agent: e.target.value || DEFAULT_USER_AGENT })
              }
            />
          </div>
        </div>
      </PaneSection>
    </div>
  )
}

import type { ComponentProps } from 'react'
import type { Dashboard } from '@/types/panel-overview'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import {
  type CredType,
  authSchemeLabel,
  authSchemeOf,
  credTypeLabel,
} from '@/lib/cred-type'
import { extraUsageText } from '@/lib/fable-status'
import { fmtExpiresAt, fmtNum, pct } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier, credExpiry } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { StatusMark } from '@/components/status-mark'
import { AllowedModelsCard } from '@/features/vm/allowed-models-card'
import { AuthSchemeEditor } from '@/features/vm/auth-scheme-editor'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { ConvertOauthToSetupButton } from '@/features/vm/convert-oauth-button'
import { CredentialEditorButton } from '@/features/vm/credential-editor'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { Field, Meter } from '@/features/vm/detail-section-primitives'
import type { VmTodayCounts } from '@/features/vm/detail-today'
import { OfficialCcCard } from '@/features/vm/official-cc-card'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { isRemoteVm, remoteUnsupportedText } from '@/features/vm/placement'
import {
  latestProbe,
  probeOutcome,
  probeSourceLabel,
  type ProbeCheck,
} from '@/features/vm/probe-status'
import { VmPackageButton } from '@/features/vm/vm-package-dialog'
import { useVmPerms } from '@/features/vm/vm-perms'

type VmAccountTabProps = {
  id: string
  vm: Vm
  acc: Record<string, unknown>
  dash: { data: Dashboard | undefined }
  credType: CredType
  officialCc: boolean
  u5: number
  u7: number
  tierKey: string
  todayReadCache: number
  todayWriteCache: number
  todayHit: number | null
  today: VmTodayCounts
  canRefresh: boolean
  refreshBlocked: string
  busy: (path: string) => boolean
  onNeedProxy: () => void
  onAction: (path: string, body?: unknown) => void
  onCredentialCommitted: NonNullable<
    ComponentProps<typeof CredentialPanel>['onCommitted']
  >
}

export function VmAccountTab(props: VmAccountTabProps) {
  const { t: tVm } = useTranslation('vm')

  const {
    id,
    vm,
    acc,
    credType,
    officialCc,
    todayReadCache,
    todayWriteCache,
    todayHit,
    today,
    canRefresh,
    refreshBlocked,
    busy,
    onNeedProxy,
    onAction,
    onCredentialCommitted,
  } = props
  const perms = useVmPerms()
  const blocked = vm.can_import_credential === false
  const gpt = isCodexVm(vm)
  const remote = isRemoteVm(vm)
  const probe = latestProbe(
    acc.last_probe_check as ProbeCheck | undefined,
    vm.last_probe_check,
    acc.last_probe as ProbeCheck | undefined,
    vm.last_probe
  )

  return (
    <TabsContent value='account' className='space-y-3 pt-3'>
      <div
        className={cn(
          'grid gap-3',
          perms.credential &&
            'xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]'
        )}
      >
        {perms.credential ? (
          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>
                <Trans ns='vm' i18nKey='detailAccountTab.importCredentials' />
              </CardTitle>
            </CardHeader>
            <CardContent className='pt-0'>
              {blocked ? (
                <div className='space-y-3'>
                  <p className='text-sm text-muted-foreground'>
                    <Trans
                      ns='vm'
                      i18nKey='detailAccountTab.thisSlotRequiresABoundHealthySOCKS5ProxyTo'
                    />
                  </p>
                  {perms.admin ? (
                    <Button size='sm' onClick={onNeedProxy}>
                      <Trans ns='vm' i18nKey='detailAccountTab.bindAProxy' />
                    </Button>
                  ) : null}
                </div>
              ) : gpt ? (
                <CodexCredentialPanel
                  vm={vm}
                  onCommitted={onCredentialCommitted}
                />
              ) : (
                <CredentialPanel
                  vm={vm}
                  onCommitted={onCredentialCommitted}
                  showConvert={false}
                />
              )}
            </CardContent>
          </Card>
        ) : null}

        <div className='space-y-3'>
          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>
                <Trans ns='vm' i18nKey='detailAccountTab.account' />
              </CardTitle>
            </CardHeader>
            <CardContent className='divide-y pt-0'>
              <Field label={tVm('vm:detailAccountTab.type')} compact>
                {credType === 'none' ? '—' : credTypeLabel(credType)}
              </Field>
              <Field label={tVm('vm:detailAccountTab.status')} compact>
                <StatusMark tone={credExpiry(vm)} variant='pill' />
              </Field>
              {claudeTier(vm).key !== 'none' ? (
                <Field label={tVm('vm:detailAccountTab.plan')} compact>
                  {gpt ? (
                    <OpenaiPlanBadge vm={vm} />
                  ) : (
                    <StatusMark tone={claudeTier(vm)} variant='pill' />
                  )}
                </Field>
              ) : null}
              {gpt ? (
                <Field
                  label={tVm(
                    'vm:detailAccountTab.subscriptionExpiryFromCredentials'
                  )}
                  compact
                >
                  {fmtExpiresAt(vm.chatgpt_subscription_active_until)}
                </Field>
              ) : null}
              {credType === 'apikey' ? (
                <Field label={tVm('vm:labels.key')} compact>
                  {vm.has_token ? tVm('vm:detailAccountTab.written') : '—'}
                </Field>
              ) : (
                <>
                  <Field label={tVm('vm:labels.accessToken')} compact>
                    {vm.has_token ? tVm('vm:detailAccountTab.bound') : '—'}
                  </Field>
                  <Field label={tVm('vm:labels.refreshToken')} compact>
                    {vm.has_refresh ? tVm('vm:detailAccountTab.bound') : '—'}
                  </Field>
                  <Field label={tVm('vm:detailAccountTab.expiry')} compact>
                    {fmtExpiresAt(vm.expires_at)}
                  </Field>
                </>
              )}
              {gpt ? null : (
                <Field
                  label={tVm('vm:credentialPanel.upstreamAuthenticationHeader')}
                  compact
                >
                  <div className='flex items-center gap-1'>
                    <span>{authSchemeLabel(authSchemeOf(vm))}</span>
                    {vm.auth_scheme ? null : (
                      <span className='text-xs text-muted-foreground'>
                        <Trans ns='vm' i18nKey='detailAccountTab.default' />
                      </span>
                    )}
                    <AuthSchemeEditor vm={vm} />
                  </div>
                </Field>
              )}
              <Field
                label={gpt ? tVm('vm:detailAccountTab.chatGPTAccount') : 'UUID'}
                compact
              >
                {gpt ? (
                  <span className='text-sm'>
                    {String(
                      vm.email || vm.account_uuid || acc.account_id || '—'
                    )}
                  </span>
                ) : (
                  <span className='font-mono text-xs'>
                    {String(vm.account_uuid || acc.account_id || '—')}
                  </span>
                )}
              </Field>
              <Field label={tVm('vm:labels.organization')} compact>
                <span className='font-mono text-xs'>
                  {String(vm.org_uuid || '—')}
                </span>
              </Field>
              {gpt ? null : (
                <Field label={tVm('vm:detailAccountTab.source')} compact>
                  {String(vm.oauth_source || '—')}
                </Field>
              )}
              <div className='flex flex-wrap items-center gap-2 pt-2'>
                {gpt ? null : (
                  <ConvertOauthToSetupButton
                    vm={vm}
                    onCommitted={onCredentialCommitted}
                  />
                )}
                {gpt ? null : <CredentialEditorButton vmId={id} />}
                <VmPackageButton vmId={id} />
                {perms.credential ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={!canRefresh}
                          loading={busy('/oauth/refresh')}
                          onClick={() => onAction('/oauth/refresh', {})}
                        >
                          <Trans
                            ns='vm'
                            i18nKey='detailAccountTab.refreshCredentials'
                          />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {refreshBlocked ? (
                      <TooltipContent>{refreshBlocked}</TooltipContent>
                    ) : null}
                  </Tooltip>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <div className='grid grid-cols-2 gap-3'>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>
                  <Trans ns='vm' i18nKey='detailAccountTab.probe' />
                </CardTitle>
              </CardHeader>
              <CardContent className='divide-y pt-0'>
                <Field label={tVm('vm:detailAccountTab.time')} compact>
                  <span className='font-mono text-xs'>
                    {probe.at || probe.probed_at
                      ? fmtExpiresAt(probe.at || probe.probed_at)
                      : tVm('vm:detailAccountTab.notProbed')}
                  </span>
                </Field>
                <Field label={tVm('vm:detailAccountTab.source')} compact>
                  {probeSourceLabel(
                    probe.source ||
                      String(acc.probe_source ?? vm.probe_source ?? '')
                  )}
                </Field>
                <Field label={tVm('vm:detailAccountTab.result')} compact>
                  {probeOutcome(probe)}
                </Field>
                {probe.via === 'passive-headers' ? (
                  <Field label={tVm('vm:detailAccountTab.sampleTime')} compact>
                    {probe.data_at
                      ? fmtExpiresAt(probe.data_at)
                      : tVm('vm:detailAccountTab.unknown')}
                  </Field>
                ) : null}
                {gpt ? null : (
                  <Field label={tVm('vm:detailAccountTab.overage')} compact>
                    {extraUsageText(acc.extra_usage ?? vm.extra_usage)}
                  </Field>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>
                  <Trans ns='vm' i18nKey='detailAccountTab.today' />
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-2 pt-0'>
                <div className='grid grid-cols-3 gap-2 text-center'>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>
                      <Trans ns='vm' i18nKey='detailAccountTab.requests' />
                    </div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(today.requests)}
                    </div>
                  </div>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>
                      <Trans ns='vm' i18nKey='detailAccountTab.input' />
                    </div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(today.input)}
                    </div>
                  </div>
                  <div>
                    <div className='text-[11px] text-muted-foreground'>
                      <Trans ns='vm' i18nKey='detailAccountTab.output' />
                    </div>
                    <div className='text-sm font-semibold tabular-nums'>
                      {fmtNum(today.output)}
                    </div>
                  </div>
                </div>
                <Meter
                  label={tVm('vm:detailAccountTab.cacheHit')}
                  value={todayHit ?? 0}
                  kind='remain'
                  hint={tVm('vm:detailAccountTab.readWrite', {
                    value1: fmtNum(todayReadCache),
                    value2: fmtNum(todayWriteCache),
                  })}
                />
                {gpt ? null : (
                  <Meter
                    label={tVm('vm:detailAccountTab.7DaySonnet')}
                    value={pct(
                      acc.utilization_7d_sonnet ?? vm.utilization_7d_sonnet
                    )}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {gpt || !perms.admin ? null : officialCc ? (
        <OfficialCcCard
          vmId={id}
          blockedReason={remote ? remoteUnsupportedText() : ''}
        />
      ) : credType !== 'none' ? (
        <p className='text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='detailAccountTab.officialClaudeCodeSetupRequiresFullOAuthCredentialsThis'
            values={{ credTypeLabel: credTypeLabel(credType) }}
          />
        </p>
      ) : null}

      <AllowedModelsCard vm={vm} />
    </TabsContent>
  )
}

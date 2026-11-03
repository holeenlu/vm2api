import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { OfficialCcStatus } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmOfficialCcQueryOptions, vmQueryOptions } from '@/features/vm/queries'
import { localizedOption } from './localized-option'

const STEP_LABELS: Record<string, string> = {
  get queued() {
    return tVm('vm:officialCcCard.queued')
  },
  get wipe() {
    return tVm('vm:officialCcCard.clearSetupEnvironment')
  },
  get refresh() {
    return tVm('vm:officialCcCard.refreshExpiredToken')
  },
  get login() {
    return tVm('vm:officialCcCard.writeOfficialLoginFiles')
  },
  get hello() {
    return tVm('vm:officialCcCard.firstConversationHello')
  },
  get usage() {
    return tVm('vm:officialCcCard.slotUsageQuota')
  },
  get profile() {
    return tVm('vm:officialCcCard.readAccountTierAndModels')
  },
  get seed() {
    return tVm('vm:officialCcCard.applySeedOverridesAfterward')
  },
  get telemetry() {
    return tVm('vm:officialCcCard.writeTelemetryConfiguration')
  },
  get resident() {
    return tVm('vm:officialCcCard.keepRunningAfterHello')
  },
  get done() {
    return tVm('vm:officialCcCard.complete')
  },
}

export function officialCcStepLabel(step?: string): string {
  return (
    STEP_LABELS[String(step || '')] || step || tVm('vm:officialCcCard.prepare')
  )
}

export function officialCcErrorHint(err?: string | null): string {
  const s = String(err || '')
  if (!s) return ''
  if (/invalid_grant|refresh token not found|could not be refreshed/i.test(s))
    return tVm('vm:officialCcCard.refreshTokenIsInvalidExchangeTokensAgainIfIt')
  if (/not logged in|please run \/login/i.test(s))
    return tVm(
      'vm:officialCcCard.officialCLIIsNotLoggedInConfirmCredentialsWere'
    )
  if (/timed out|timeout/i.test(s))
    return tVm(
      'vm:officialCcCard.officialConversationTimedOutRunOfficialSetupAgainOn'
    )
  if (/\/usage|usage probe|official-cc-usage/i.test(s))
    return tVm('vm:officialCcCard.slotUsageFailedAfterTwoRetriesCheckTheSlot')
  if (/no live oauth|no_credential|credential/i.test(s))
    return tVm(
      'vm:officialCcCard.noUsableOAuthCredentialsExchangeTokensBeforeRunningOfficial'
    )
  if (/already_running/i.test(s))
    return tVm(
      'vm:officialCcCard.setupIsAlreadyRunningWaitOrRefreshItsProgress'
    )
  if (/disabled/i.test(s))
    return tVm(
      'vm:officialCcCard.automaticSetupAfterTokenExchangeIsDisabledYouCan'
    )
  if (/bridge/i.test(s))
    return tVm('vm:officialCcCard.slotSOCKS5BridgeIsNotRunningCheckTheProxy')
  return tVm('vm:officialCcCard.youCanRunOfficialSetupAgainHere')
}

const TRACK: [string, string][] = [
  localizedOption('queued', 'vm:officialCcCard.queued'),
  localizedOption('wipe', 'vm:officialCcCard.empty'),
  localizedOption('login', 'vm:officialCcCard.write'),
  localizedOption('hello', 'vm:officialCcCard.greetingTest'),
  localizedOption('stats', 'vm:detailStatusBoard.quota'),
  localizedOption('seed', 'vm:officialCcCard.applySeed'),
  localizedOption('done', 'vm:officialCcCard.complete'),
]

function trackIndex(step?: string): number {
  const map: Record<string, number> = {
    queued: 0,
    wipe: 1,
    refresh: 1,
    login: 2,
    hello: 3,
    usage: 4,
    profile: 4,
    seed: 5,
    telemetry: 5,
    resident: 6,
    done: 6,
  }
  const n = map[String(step || '')]
  return n == null ? -1 : n
}

export function OfficialCcTrack({ cc }: { cc: OfficialCcStatus | null }) {
  const { t: tVm } = useTranslation('vm')

  const st = cc?.status || ''
  const idx = st === 'ok' ? TRACK.length - 1 : trackIndex(cc?.step)
  return (
    <ol
      className='flex flex-wrap items-center gap-2'
      aria-label={tVm('vm:officialCcCard.setupProgress')}
    >
      {TRACK.map(([key, label], i) => {
        const on = idx > 0 && i < idx
        const cur =
          st === 'ok' ? i === TRACK.length - 1 : i === Math.max(idx, 0)
        const bad = st === 'error' && cur
        const color = bad
          ? 'var(--status-bad)'
          : on
            ? 'var(--status-ok)'
            : cur
              ? 'var(--status-caution)'
              : 'var(--status-none)'
        return (
          <li key={key} className='inline-flex items-center gap-1 text-[11px]'>
            <span
              aria-hidden='true'
              className='inline-block size-2 rounded-full'
              style={{ background: color }}
            />
            <span
              className={
                cur || on || bad ? 'text-foreground' : 'text-muted-foreground'
              }
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function OfficialCcFacts({ cc }: { cc: OfficialCcStatus | null }) {
  const { t: tVm } = useTranslation('vm')

  if (!cc) {
    return (
      <p className='text-xs text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='officialCcCard.runOfficialSetupUsingThisSlotSCredentialsOn'
        />
      </p>
    )
  }
  const quota =
    cc.hello_ok && (cc.usage_ok || cc.stats_ok)
      ? tVm('vm:officialCcCard.quotaProbed')
      : cc.hello_ok
        ? 'hello'
        : ''
  const resident = cc.resident_ok
    ? tVm('vm:officialCcCard.persistentProcessRunning')
    : cc.resident
      ? tVm('vm:officialCcCard.persistentProcessNotStarted')
      : ''
  const tel =
    cc.telemetry_enabled && cc.telemetry_official
      ? tVm('vm:officialCcCard.telemetryAligned')
      : cc.telemetry_enabled
        ? tVm('vm:officialCcCard.telemetryWritten')
        : ''
  const bits = [cc.account_tier, quota, resident, tel].filter(Boolean)
  return (
    <p className='text-xs text-muted-foreground'>
      {bits.length
        ? bits.join(' · ')
        : tVm('vm:officialCcCard.setupHasNotProducedProbeResultsYet')}
    </p>
  )
}

function toneOf(status?: string): StatusTone {
  if (status === 'ok')
    return { key: 'ok', text: tVm('vm:officialCcCard.completed'), cls: 'ok' }
  if (status === 'running')
    return {
      key: 'warn',
      text: tVm('vm:officialCcCard.inProgress'),
      cls: 'warn',
    }
  if (status === 'error')
    return { key: 'bad', text: tVm('vm:officialCcCard.failed'), cls: 'bad' }
  return { key: 'none', text: tVm('vm:officialCcCard.notSetUp'), cls: 'none' }
}

/** `blockedReason` 非空时禁用「执行官方初装」并在按钮旁给出原因（如远端节点）。 */
export function OfficialCcCard({
  vmId,
  blockedReason = '',
}: {
  vmId: string
  blockedReason?: string
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const queryOptions = vmOfficialCcQueryOptions(vmId)
  const key = queryOptions.queryKey
  const q = useQuery(queryOptions)

  const cc = q.data
  const running = cc?.status === 'running'

  // The poll stopping is the only signal a background job finished — say so.
  const seen = useRef<string>('')
  useEffect(() => {
    const st = cc?.status
    if (!st || st === 'running') {
      if (st === 'running') seen.current = 'running'
      return
    }
    if (seen.current !== 'running') return
    seen.current = st
    if (st === 'ok') {
      toast.success(
        tVm(
          cc?.telemetry_official
            ? 'vm:messages.setupCompletedAligned'
            : 'vm:messages.setupCompleted',
          { tier: cc?.account_tier || '—' }
        )
      )
    } else if (st === 'error') {
      const hint = officialCcErrorHint(cc?.error)
      const error = cc?.error || tVm('vm:officialCcCard.officialSetupFailed')
      toast.error(
        hint ? tVm('vm:messages.failureWithHint', { error, hint }) : error
      )
    }
    qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
  }, [cc, qc, vmId, tVm])

  const run = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/official-cc-bootstrap`, {
        method: 'POST',
        body: JSON.stringify({ force: true, manual: true }),
      }),
    onSuccess: (r) => {
      const d = (r as { scheduled?: boolean; reason?: string }) || {}
      if (d.scheduled === false && d.reason === 'already_initialized') {
        toast.success(
          tVm('vm:officialCcCard.thisSlotWasAlreadySetUpOfficialCLIWas')
        )
      } else if (d.scheduled === false && d.reason === 'disabled') {
        toast.info(
          tVm(
            'vm:officialCcCard.automaticSetupAfterTokenExchangeIsDisabledThisRun'
          )
        )
      } else if (
        d.scheduled === false &&
        d.reason === 'credential_mode_unsupported'
      ) {
        // 与「刷新凭证」的同名 400 语义不同：这里是初装不适用，不是凭证坏了
        toast.info(
          tVm(
            'vm:officialCcCard.officialSetupRequiresFullOAuthCredentialsThisSlotIs'
          )
        )
      } else if (d.scheduled === false && d.reason) {
        toast.info(
          tVm('vm:officialCcCard.officialSetupNotQueued', { reason: d.reason })
        )
      } else {
        toast.success(
          tVm('vm:officialCcCard.officialSetupQueuedTrackingProgress')
        )
      }
      qc.invalidateQueries({ queryKey: key })
    },
    onError: (e: Error) =>
      toast.error(e.message || tVm('vm:officialCcCard.officialSetupFailed')),
  })

  const tone = toneOf(cc?.status)
  const hint = cc?.status === 'error' ? officialCcErrorHint(cc.error) : ''
  const runLabel = running
    ? tVm('vm:officialCcCard.setupInProgress')
    : cc?.status === 'error'
      ? tVm('vm:officialCcCard.runOfficialSetupAgain')
      : cc?.status === 'ok'
        ? tVm('vm:officialCcCard.retryOfficialSetup')
        : tVm('vm:detailOpsTab.runOfficialSetup')

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Trans
            ns='vm'
            i18nKey='officialCcCard.officialClaudeCodeSetup'
            components={{
              part0: <StatusMark tone={tone} variant='pill' />,
              part1: (
                <>
                  {running ? (
                    <span className='text-xs font-normal text-muted-foreground'>
                      {officialCcStepLabel(cc?.step)}
                    </span>
                  ) : null}
                </>
              ),
            }}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <OfficialCcTrack cc={cc || null} />
        <div className='flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {cc?.account_tier ? <span>{cc.account_tier}</span> : null}
          {cc?.available_models?.length ? (
            <span title={cc.available_models.join('\n')}>
              <Trans
                ns='vm'
                i18nKey='officialCcCard.availableModels'
                values={{ length: cc.available_models.length }}
                count={cc.available_models.length}
              />
            </span>
          ) : null}
          {cc?.hello_ok && (cc?.usage_ok || cc?.stats_ok) ? (
            <span>
              <Trans ns='vm' i18nKey='officialCcCard.quotaProbed' />
            </span>
          ) : cc?.hello_ok ? (
            <span>
              <Trans ns='vm' i18nKey='officialCcCard.helloCompleted' />
            </span>
          ) : null}
          {cc?.resident_ok ? (
            <span>
              <Trans
                ns='vm'
                i18nKey='officialCcCard.persistentProcessRunningAlternative'
                values={{
                  value: cc.resident_pid ? ` · pid ${cc.resident_pid}` : '',
                }}
              />
            </span>
          ) : cc?.resident ? (
            <StatusMark
              tone={{
                key: 'warn',
                text: tVm('vm:officialCcCard.persistentProcessNotStarted'),
                cls: 'warn',
              }}
            />
          ) : null}
          {cc?.telemetry_enabled && cc?.telemetry_official ? (
            <span>
              <Trans ns='vm' i18nKey='officialCcCard.telemetryAligned' />
            </span>
          ) : cc?.telemetry_enabled ? (
            <span>
              <Trans ns='vm' i18nKey='officialCcCard.telemetryWritten' />
            </span>
          ) : null}
          {!cc ? (
            <span>
              <Trans
                ns='vm'
                i18nKey='officialCcCard.runOfficialSetupUsingThisSlotSCredentialsOn'
              />
            </span>
          ) : null}
        </div>

        {cc?.error ? (
          <div className='space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs'>
            <div>
              <span className='font-medium'>
                <Trans ns='vm' i18nKey='officialCcCard.error' />
              </span>{' '}
              · <span className='font-mono break-all'>{cc.error}</span>
            </div>
            {hint ? <div className='text-muted-foreground'>{hint}</div> : null}
          </div>
        ) : null}

        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant={cc?.status === 'error' ? 'default' : 'outline'}
            disabled={running || run.isPending || !!blockedReason}
            onClick={() => run.mutate()}
          >
            {run.isPending ? tVm('vm:officialCcCard.submitting') : runLabel}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={running || q.isFetching}
            onClick={() => q.refetch()}
          >
            {running
              ? tVm('vm:officialCcCard.refreshesEvery25s')
              : q.isFetching
                ? tVm('vm:credentialEditor.loading')
                : tVm('vm:officialCcCard.refreshProgress')}
          </Button>
          {blockedReason ? (
            <span className='text-xs text-muted-foreground'>
              {blockedReason}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

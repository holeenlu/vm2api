import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, api, isApiError } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  changelogQueryOptions,
  versionQueryOptions,
  type ChangelogEntry,
  type ReleaseStatus,
} from '@/features/settings/queries'

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

export function AboutPane() {
  const { t } = useTranslation('settings')

  const qc = useQueryClient()
  const [upgradeTarget, setUpgradeTarget] = useState<string | null>(null)
  const version = useQuery({
    ...versionQueryOptions(),
    refetchInterval: (query) =>
      upgradeTarget || query.state.data?.upgrade?.state === 'running'
        ? 2000
        : false,
  })
  const changelog = useQuery(changelogQueryOptions())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const data = version.data
  const checkFailed =
    version.isError || !!data?.source_error || data?.check_status === 'failed'
  const updateRunning = !!upgradeTarget || data?.upgrade?.state === 'running'

  useEffect(() => {
    if (!upgradeTarget) return
    if (data?.upgrade?.target !== upgradeTarget) return
    if (data.upgrade.state === 'failed') {
      setUpgradeTarget(null)
      toast.error(t('about.upgradeFailed'))
    } else if (
      data.upgrade.state === 'succeeded' &&
      data.current_tag === upgradeTarget
    ) {
      setUpgradeTarget(null)
      window.location.reload()
    }
  }, [data, upgradeTarget, t])

  const upgrade = useMutation({
    mutationFn: () =>
      api<ReleaseStatus>('/api/panel/update', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          version: data?.latest_tag,
        }),
      }),
    onSuccess: async (payload) => {
      setConfirmOpen(false)
      if (payload?.message === 'already_latest') {
        toast.success(
          t('about.upToDateVersion', { value1: payload.current_tag })
        )
        return
      }
      if (payload?.started) {
        setUpgradeTarget(payload.target || payload.latest_tag)
        qc.setQueryData(versionQueryOptions().queryKey, payload)
        toast.info(
          t('about.upgrading', { value1: payload.target || payload.latest_tag })
        )
      }
    },
    onError: (error: Error) => {
      setConfirmOpen(false)
      if (isApiError(error) && error.code === 'host_upgrade_required') {
        const command =
          (error.data as { command?: string } | undefined)?.command ||
          data?.upgrade_command
        toast.error(error.message)
        if (command) {
          copyText(command)
            .then(() => toast.success(t('about.hostCommandCopied')))
            .catch(() => undefined)
        }
        return
      }
      if (
        error instanceof TypeError ||
        /failed to fetch|network|load failed/i.test(error.message)
      ) {
        toast.info(t('about.connectionLost'))
        void qc.invalidateQueries({ queryKey: versionQueryOptions().queryKey })
        return
      }
      toast.error(error.message)
    },
  })

  const rawEntries =
    data?.changelog && data.changelog.length > 0
      ? data.changelog
      : changelog.data?.entries?.filter(
          (entry) => entry.version !== 'unreleased'
        ) || []
  const entries = data?.update_available ? rawEntries : rawEntries.slice(0, 8)

  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader className='flex flex-row items-center justify-between space-y-0'>
          <CardTitle>{t('about.version')}</CardTitle>
          <Button
            size='sm'
            variant='outline'
            onClick={() => version.refetch()}
            loading={version.isFetching}
          >
            <RefreshCw />
            {t('about.checkUpdates')}
          </Button>
        </CardHeader>
        <CardContent className='space-y-3'>
          {version.isError ? (
            <Alert variant='destructive'>
              <AlertTitle>{t('about.checkFailed')}</AlertTitle>
              <AlertDescription>
                {version.error instanceof ApiError
                  ? version.error.message
                  : t('about.versionUnavailable')}
              </AlertDescription>
            </Alert>
          ) : null}
          <dl className='grid gap-2 text-sm sm:grid-cols-2'>
            <div>
              <dt className='text-muted-foreground'>{t('about.current')}</dt>
              <dd className='font-mono'>{data?.current_tag || '—'}</dd>
            </div>
            <div>
              <dt className='text-muted-foreground'>
                {t('about.latestGitHub')}
              </dt>
              <dd className='flex items-center gap-2 font-mono'>
                {checkFailed ? '—' : data?.latest_tag || '—'}
                {checkFailed ? (
                  <Badge variant='destructive'>{t('about.checkFailed')}</Badge>
                ) : data?.update_available ? (
                  <Badge>{t('about.updateAvailable')}</Badge>
                ) : data?.update_available === false ? (
                  <Badge variant='secondary'>{t('about.upToDate')}</Badge>
                ) : null}
              </dd>
            </div>
          </dl>
          {data?.source_error ? (
            <p className='text-sm text-muted-foreground'>
              {t('about.githubUnavailable', { value1: data.source_error })}
            </p>
          ) : null}
          {updateRunning ? (
            <Alert>
              <AlertTitle>
                {t('about.updating', {
                  value1: upgradeTarget || data?.upgrade?.target,
                })}
              </AlertTitle>
              <AlertDescription>{t('about.verifying')}</AlertDescription>
            </Alert>
          ) : data?.upgrade?.state === 'failed' ? (
            <Alert variant='destructive'>
              <AlertTitle>{t('about.updateFailed')}</AlertTitle>
              <AlertDescription>{data.upgrade.log_command}</AlertDescription>
            </Alert>
          ) : null}
          {data?.needs_wrap_cli_sync ? (
            <Alert>
              <AlertTitle>{t('about.kernelRequired')}</AlertTitle>
              <AlertDescription>{t('about.kernelHelp')}</AlertDescription>
            </Alert>
          ) : null}
          {data?.html_url ? (
            <a
              href={data.html_url}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-1 text-sm text-primary hover:underline'
            >
              {t('about.githubRelease')}
              <ExternalLink className='size-3.5' />
            </a>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('about.oneClickUpdate')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p className='text-sm text-muted-foreground'>
            {t('about.updateScope')}
          </p>
          <pre className='overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs'>
            {data?.upgrade_command ||
              'curl -sSL https://raw.githubusercontent.com/holeenlu/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade'}
          </pre>
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                const command = data?.upgrade_command
                if (!command) return
                copyText(command)
                  .then(() => toast.success(t('copied')))
                  .catch(() => toast.error(t('copyFailed')))
              }}
            >
              <Copy />
              {t('about.copyCommand')}
            </Button>
            <Button
              size='sm'
              disabled={
                checkFailed ||
                !data?.update_available ||
                upgrade.isPending ||
                updateRunning
              }
              onClick={() => setConfirmOpen(true)}
            >
              <ArrowUpCircle />
              {t('about.startFromPanel')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('about.changelog')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-4'>
          {entries.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('about.noNewEntries')}
            </p>
          ) : (
            entries.map((entry) => (
              <ChangelogBlock key={entry.heading} entry={entry} />
            ))
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('about.confirmVersion', { value1: data?.latest_tag || '' })}
        desc={t('about.confirmDescription')}
        confirmText={t('about.startUpgrade')}
        cancelBtnText={t('cancel')}
        destructive
        isLoading={upgrade.isPending}
        handleConfirm={() => upgrade.mutate()}
      />
    </div>
  )
}

function ChangelogBlock({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className='space-y-1.5 wrap-anywhere'>
      <div className='flex flex-wrap items-baseline gap-2'>
        <h3 className='font-medium'>
          {entry.tag || entry.version}
          {entry.date ? (
            <span className='ms-2 text-sm font-normal text-muted-foreground'>
              {entry.date}
            </span>
          ) : null}
        </h3>
        {entry.needs_wrap_cli_sync ? (
          <Badge variant='outline'>wrap-cli/sync</Badge>
        ) : null}
      </div>
      {entry.title ? (
        <p className='text-sm text-muted-foreground'>{entry.title}</p>
      ) : null}
      {entry.bullets.length > 0 ? (
        <ul className='list-disc space-y-1 ps-5 text-sm'>
          {entry.bullets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

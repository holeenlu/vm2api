import { useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  RefreshCw,
  ArrowUpCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { ReleaseStatus } from './queries'
import { useVersionUpdate } from './use-version-update'

export function VersionMenu({
  currentVersion,
  className,
}: {
  currentVersion?: string
  className?: string
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [panelSize, setPanelSize] = useState<{
    width: number
    offset: number
  } | null>(null)
  function changeOpen(next: boolean) {
    if (next && trigger.current) {
      const button = trigger.current.getBoundingClientRect()
      const title = trigger.current
        .closest('[data-sidebar="menu-item"]')
        ?.getBoundingClientRect()
      if (title?.width)
        setPanelSize({ width: title.width, offset: title.left - button.left })
    }
    setOpen(next)
  }
  const update = useVersionUpdate()
  const current =
    update.data?.current_tag || currentVersion?.replace(/^v?/i, 'v') || '—'
  const available =
    !update.checkFailed && update.data?.update_available === true
  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type='button'
            className={cn(
              'inline-flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md bg-sidebar-foreground/[0.04] px-2.5 py-1.5 text-xs font-medium text-sidebar-foreground/70 outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring',
              className
            )}
            aria-label={`${t('about.version')} ${current}`}
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full shadow-[0_0_0_2px]',
                available
                  ? 'bg-amber-500 shadow-amber-500/20'
                  : 'bg-primary shadow-primary/20'
              )}
            />
            <span className='font-mono font-medium break-all tabular-nums'>
              {current}
            </span>
            {available && (
              <span className='rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300'>
                {t('about.updateAvailable')}
              </span>
            )}
            <ChevronDown
              aria-hidden
              className='ms-auto size-3.5 shrink-0 opacity-60'
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          alignOffset={panelSize?.offset ?? 0}
          side='bottom'
          style={panelSize ? { width: panelSize.width } : undefined}
          className='max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[calc(100vw_-_1rem)] overflow-y-auto rounded-xl p-0'
        >
          <VersionDetails
            data={update.data}
            currentVersion={current}
            checking={update.version.isFetching || update.check.isPending}
            error={update.version.error?.message}
            running={update.updateRunning}
            target={update.upgradeTarget || update.data?.upgrade?.target}
            pending={update.upgrade.isPending}
            onCheck={() => update.check.mutate()}
            onUpgrade={() => {
              setOpen(false)
              update.setConfirmOpen(true)
            }}
            onChangelog={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={update.confirmOpen}
        onOpenChange={update.setConfirmOpen}
        title={t('about.confirmVersion', {
          value1: update.data?.latest_tag || '',
        })}
        desc={t('about.confirmDescription')}
        confirmText={t('about.startUpgrade')}
        cancelBtnText={t('cancel')}
        destructive
        isLoading={update.upgrade.isPending}
        disabled={
          update.checkFailed ||
          !update.data?.update_available ||
          update.updateRunning
        }
        handleConfirm={() => {
          setOpen(true)
          update.upgrade.mutate()
        }}
      />
    </>
  )
}

export function VersionDetails({
  data,
  currentVersion,
  checking = false,
  error,
  running = false,
  target,
  pending = false,
  onCheck,
  onUpgrade,
  onChangelog,
}: {
  data?: ReleaseStatus
  currentVersion?: string
  checking?: boolean
  error?: string
  running?: boolean
  target?: string | null
  pending?: boolean
  onCheck?: () => void
  onUpgrade?: () => void
  onChangelog?: () => void
}) {
  const { t } = useTranslation('settings')
  const failed =
    !running &&
    (!!error || !!data?.source_error || data?.check_status === 'failed')
  const available = !failed && data?.update_available === true
  const command = data?.upgrade_command
  return (
    <section aria-label={t('about.version')}>
      <div className='flex items-center justify-between border-b px-3 py-2'>
        <h2 className='font-semibold'>{t('about.version')}</h2>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          aria-label={t('about.checkUpdates')}
          title={t('about.checkUpdates')}
          loading={checking}
          disabled={running || pending}
          onClick={onCheck}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className='space-y-2.5 p-3'>
        <div className='space-y-1'>
          <div className='flex items-center justify-between gap-2'>
            <span className='shrink-0 text-xs text-muted-foreground'>
              {t('about.current')}
            </span>
            <strong className='text-lg break-all tabular-nums'>
              {data?.current_tag || currentVersion || '—'}
            </strong>
            {!failed && data?.update_available === false && (
              <Check className='size-6 rounded-full bg-primary/10 p-1 text-primary' />
            )}
          </div>
          {failed ? (
            <p role='alert' className='text-sm text-destructive'>
              {t('about.checkFailed')}
              {error ? ` · ${error}` : ''}
            </p>
          ) : data?.update_available === false ? (
            <p className='text-sm text-muted-foreground'>
              {t('about.upToDate')}
            </p>
          ) : null}
        </div>
        {!running && data?.source_error && (
          <p className='text-xs text-muted-foreground'>
            {t('about.githubUnavailable', { value1: data.source_error })}
          </p>
        )}
        {running && (
          <Alert>
            <AlertTitle>{t('about.updating', { value1: target })}</AlertTitle>
            <AlertDescription className='space-y-2'>
              <span>
                {t(
                  `about.upgradePhase.${data?.upgrade?.phase || 'verifying'}`,
                  {
                    defaultValue: t('about.verifying'),
                  }
                )}
              </span>
              {typeof data?.upgrade?.progress === 'number' && (
                <span className='block space-y-1'>
                  <span className='block h-1.5 overflow-hidden rounded-full bg-muted'>
                    <span
                      className='block h-full rounded-full bg-primary transition-[width]'
                      style={{
                        width: `${Math.max(0, Math.min(100, data.upgrade.progress))}%`,
                      }}
                    />
                  </span>
                  <span className='block text-xs text-muted-foreground'>
                    {data.upgrade.progress}%
                  </span>
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}
        {available && (
          <div className='flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs'>
            <p className='font-semibold'>{t('about.updateAvailable')}</p>
            <p className='font-mono break-all'>{data.latest_tag}</p>
          </div>
        )}
        <Button
          size='sm'
          className='w-full'
          disabled={!available || running || pending}
          onClick={onUpgrade}
          loading={pending}
        >
          <ArrowUpCircle />
          {t('about.startUpgrade')}
        </Button>
        {data?.needs_wrap_cli_sync && (
          <Alert>
            <AlertTitle>{t('about.kernelRequired')}</AlertTitle>
            <AlertDescription>{t('about.kernelHelp')}</AlertDescription>
          </Alert>
        )}
        <div className='flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs'>
          {data?.html_url && (
            <a
              href={data.html_url}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-1 text-muted-foreground hover:text-primary'
            >
              {t('about.githubRelease')}
              <ExternalLink className='size-3.5' />
            </a>
          )}
          <a
            href='#/settings/about'
            onClick={onChangelog}
            className='text-primary hover:underline'
          >
            {t('about.changelog')}
          </a>
        </div>
        {command && (
          <details className='border-t pt-2 text-xs'>
            <summary className='cursor-pointer text-muted-foreground'>
              {t('about.hostCommand')}
            </summary>
            <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
              {t('about.updateScope')}
            </p>
            <pre className='my-3 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs break-all whitespace-pre-wrap'>
              {command}
            </pre>
            <Button
              size='sm'
              variant='outline'
              onClick={() =>
                void copyText(command).then(
                  (ok) => ok && toast.success(t('copied'))
                )
              }
            >
              <Copy />
              {t('about.copyCommand')}
            </Button>
          </details>
        )}
      </div>
    </section>
  )
}

import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  Circle,
  Globe,
  KeyRound,
  ListChecks,
  LockKeyhole,
  Power,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useOnboardingAction } from './queries'
import {
  docsHref,
  hasPanelView,
  isOnboardingStepId,
  STEP_META,
  type OnboardingStepId,
} from './steps'
import type { OnboardingPayload } from './types'

const STEP_ICONS: Record<OnboardingStepId, LucideIcon> = {
  service_group: Boxes,
  admin_password: LockKeyhole,
  egress: Globe,
  slot_account: Boxes,
  schedulable: Power,
  api_key: KeyRound,
  first_request: Send,
}

export function WelcomeChecklist({
  payload,
  views,
}: {
  payload: OnboardingPayload
  views?: string[] | null
}) {
  const { t } = useTranslation('welcome')

  const action = useOnboardingAction()
  const known = payload.steps.filter(
    (step): step is { id: OnboardingStepId; done: boolean } =>
      isOnboardingStepId(step.id)
  )
  const doneCount = known.filter((step) => step.done).length
  const total = known.length
  const percent = total === 0 ? 100 : Math.round((doneCount / total) * 100)
  const next = known.find((step) => !step.done)

  function run(kind: 'complete' | 'dismiss' | 'reset') {
    action.mutate(kind, {
      onSuccess: () => {
        toast.success(
          kind === 'reset'
            ? t('welcome:showGuideAgain')
            : kind === 'complete'
              ? t('welcome:guideCompleted')
              : t('welcome:guideDismissed')
        )
      },
      onError: (error: Error) => toast.error(error.message),
    })
  }

  return (
    <section
      id='welcome-setup'
      className='relative mx-auto max-w-6xl scroll-mt-20 px-4 pb-6 sm:px-6 lg:px-8'
    >
      <div className='overflow-hidden rounded-xl border bg-card shadow-xs'>
        <div className='relative p-4 sm:p-6'>
          <div className='relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]'>
            <div className='flex min-w-0 flex-col gap-5'>
              <div className='flex max-w-2xl flex-col gap-1'>
                <div className='flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase'>
                  <ListChecks aria-hidden className='size-3.5' />
                  {t('welcome:checklist')}
                </div>
                <h2 className='text-xl font-semibold tracking-tight sm:text-2xl'>
                  {t('welcome:checklistTitle')}
                </h2>
                <p className='text-sm leading-relaxed text-muted-foreground'>
                  {t('welcome:checklistHelp')}
                </p>
              </div>

              <ol className='rounded-xl border bg-background p-2'>
                {known.map((step, i) => {
                  const meta = STEP_META[step.id]
                  const Icon = STEP_ICONS[step.id]
                  const StatusIcon = step.done ? Check : Circle
                  const showPanel = hasPanelView(views, meta.panelView)
                  return (
                    <li
                      key={step.id}
                      className='relative flex gap-3 pb-2.5 last:pb-0'
                    >
                      {i < known.length - 1 ? (
                        <span
                          aria-hidden
                          className='absolute top-9 bottom-0 left-4 w-px bg-border'
                        />
                      ) : null}
                      <span
                        className={cn(
                          'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs',
                          step.done && 'border-primary/30 bg-accent'
                        )}
                      >
                        <StatusIcon
                          aria-hidden
                          className={cn(
                            'size-4',
                            step.done
                              ? 'text-primary'
                              : 'text-muted-foreground/60'
                          )}
                        />
                        <span className='sr-only'>
                          {step.done
                            ? t('welcome:completed')
                            : t('welcome:incomplete')}
                        </span>
                      </span>
                      <div className='flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2.5 shadow-xs'>
                        <div className='flex min-w-0 items-start gap-2.5'>
                          <span className='mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted'>
                            <Icon aria-hidden className='size-3.5' />
                          </span>
                          <span className='flex min-w-0 flex-col gap-0.5'>
                            <span className='flex items-center gap-2 text-sm font-medium'>
                              <span className='font-mono text-xs text-muted-foreground tabular-nums'>
                                {i + 1}.
                              </span>
                              <span
                                className={cn(
                                  'truncate',
                                  step.done &&
                                    'text-muted-foreground line-through decoration-muted-foreground/40'
                                )}
                              >
                                {meta.title}
                              </span>
                            </span>
                            <span className='text-xs leading-relaxed text-muted-foreground'>
                              {meta.description}
                            </span>
                          </span>
                        </div>
                        <div className='ms-auto flex shrink-0 items-center gap-1'>
                          <a
                            href={docsHref(meta.docsPath)}
                            target='_blank'
                            rel='noreferrer'
                            className='inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                          >
                            {t('welcome:docs')}
                            <ArrowUpRight aria-hidden className='size-3' />
                          </a>
                          {showPanel ? (
                            <Button
                              asChild
                              size='sm'
                              variant={step.done ? 'ghost' : 'outline'}
                              className='group h-8 rounded-lg px-2.5 text-xs'
                            >
                              <Link to={meta.panelTo}>
                                {t('welcome:goTo')}
                                <ArrowRight
                                  aria-hidden
                                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                                />
                              </Link>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>

            <aside className='flex flex-col gap-4 rounded-xl border bg-background/60 p-4 backdrop-blur sm:p-5'>
              <div className='flex items-baseline justify-between'>
                <span className='text-xs font-medium tracking-wider text-muted-foreground uppercase'>
                  {t('welcome:progress')}
                </span>
                <span className='font-mono text-sm tabular-nums'>
                  {doneCount}/{total}
                </span>
              </div>
              <div
                role='progressbar'
                aria-label={t('welcome:guideProgress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className='h-2 overflow-hidden rounded-full bg-muted'
              >
                <div
                  className='h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none'
                  style={{ width: `${percent}%` }}
                />
              </div>

              {next ? (
                <div className='rounded-xl border bg-card px-3 py-3'>
                  <p className='text-xs text-muted-foreground'>
                    {t('welcome:nextStep')}
                  </p>
                  <p className='mt-0.5 text-sm font-medium'>
                    {STEP_META[next.id].title}
                  </p>
                  {hasPanelView(views, STEP_META[next.id].panelView) ? (
                    <Button
                      asChild
                      size='sm'
                      className='group mt-3 h-8 w-full rounded-lg text-xs'
                    >
                      <Link to={STEP_META[next.id].panelTo}>
                        {t('welcome:completeStep')}
                        <ArrowRight
                          aria-hidden
                          className='size-3.5 transition-transform group-hover:translate-x-0.5'
                        />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className='flex items-center gap-2 rounded-xl border bg-card px-3 py-3 text-sm'>
                  <Check aria-hidden className='size-4 text-primary' />
                  {t('welcome:allReady')}
                </div>
              )}

              <div className='mt-auto flex flex-col gap-2 border-t pt-4'>
                {payload.guide_used ? (
                  <>
                    <p className='text-xs leading-relaxed text-muted-foreground'>
                      {payload.status === 'completed'
                        ? t('welcome:guideCompletedNotice')
                        : t('welcome:guideDismissedNotice')}
                    </p>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-lg text-xs'
                      disabled={action.isPending}
                      onClick={() => run('reset')}
                    >
                      {t('welcome:restartGuide')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size='sm'
                      className='h-8 rounded-lg text-xs'
                      disabled={action.isPending}
                      onClick={() => run('complete')}
                    >
                      {t('welcome:finishGuide')}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-lg text-xs'
                      disabled={action.isPending}
                      onClick={() => run('dismiss')}
                    >
                      {t('welcome:skipGuide')}
                    </Button>
                    <p className='text-[11px] leading-relaxed text-muted-foreground'>
                      {t('welcome:guideFooter')}
                    </p>
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}

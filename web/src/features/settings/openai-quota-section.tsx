import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { OpenAIQuotaPolicy } from '@/types/panel-vm'
import { Clock3, Gauge, Info, MessageSquare, ServerCog } from 'lucide-react'
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
  OPENAI_DEFAULTS,
  getOpenaiSessionSteps,
  formatRpm,
  openaiPolicy,
  quotaDialogClass,
} from './quota-values'
import { ChipGroup, PaneSection, StepperSetting } from './scheduler-controls'

type DialogKind = 'gates' | 'concurrency' | 'rpm' | 'sessions' | 'details'

function OpenAIGates({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className='space-y-4'>
      <div className='grid gap-4 sm:grid-cols-2'>
        <RatioSetting
          id='openai-5h'
          label={t('quota.fiveHourGate')}
          value={policy.limit_5h}
          fallback={OPENAI_DEFAULTS.limit_5h}
          onChange={(limit_5h) => onChange({ limit_5h })}
        />
        <RatioSetting
          id='openai-7d'
          label={t('quota.sevenDayGate')}
          value={policy.limit_7d}
          fallback={OPENAI_DEFAULTS.limit_7d}
          onChange={(limit_7d) => onChange({ limit_7d })}
        />
      </div>
      <p className='rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'>
        {t('quota.localGateHelp')}
      </p>
    </div>
  )
}

function OpenAICapacity({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-concurrency'
        label={t('quota.concurrency')}
        desc={t('quota.openaiConcurrencyHelp')}
        value={policy.max_concurrency}
        min={1}
        max={256}
        fallback={OPENAI_DEFAULTS.max_concurrency}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
      <ChipGroup
        label={t('quota.openaiConcurrencyPresets')}
        value={policy.max_concurrency}
        options={withCurrent(
          CONC_STEPS.filter(([value]) => value > 0),
          policy.max_concurrency
        )}
        onChange={(max_concurrency) => onChange({ max_concurrency })}
      />
    </div>
  )
}

function OpenAIRpm({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-rpm'
        label={t('quota.requestRate')}
        desc={t('quota.rpmHelp')}
        value={policy.max_rpm}
        min={0}
        max={1000000}
        unit='RPM'
        fallback={OPENAI_DEFAULTS.max_rpm}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
      <ChipGroup
        label={t('quota.openaiRpmPresets')}
        value={policy.max_rpm}
        options={withCurrent(RPM_STEPS, policy.max_rpm)}
        onChange={(max_rpm) => onChange({ max_rpm })}
      />
    </div>
  )
}

function OpenAISessions({
  policy,
  onChange,
}: {
  policy: OpenAIQuotaPolicy
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div className='space-y-4'>
      <StepperSetting
        id='openai-sessions'
        label={t('quota.sessions')}
        desc={t('quota.sessionsHelp')}
        value={policy.max_sessions}
        min={0}
        max={256}
        fallback={OPENAI_DEFAULTS.max_sessions}
        onChange={(max_sessions) => onChange({ max_sessions })}
      />
      <ChipGroup
        label={t('quota.openaiSessionPresets')}
        value={policy.max_sessions}
        options={withCurrent(getOpenaiSessionSteps(), policy.max_sessions)}
        onChange={(max_sessions) => onChange({ max_sessions })}
      />
      <p className='rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'>
        {t('quota.sessionScope')}
      </p>
    </div>
  )
}

export function OpenaiQuotaSection({
  quota,
  onChange,
  saving = false,
  pending = false,
}: {
  quota: Partial<OpenAIQuotaPolicy>
  onChange: (patch: Partial<OpenAIQuotaPolicy>) => void
  saving?: boolean
  pending?: boolean
}) {
  const { t } = useTranslation('settings')

  const list = useQuery(vmsListQueryOptions(5000))
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [draft, setDraft] = useState<OpenAIQuotaPolicy>(openaiPolicy(quota))
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
    setDraft(openaiPolicy(quota))
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
      onChange({ limit_5h: draft.limit_5h, limit_7d: draft.limit_7d })
    } else if (dialog === 'concurrency') {
      onChange({ max_concurrency: draft.max_concurrency })
    } else if (dialog === 'rpm') {
      onChange({ max_rpm: draft.max_rpm })
    } else {
      onChange({ max_sessions: draft.max_sessions })
    }
    setDialog(null)
  }

  const items = (list.data?.items || []).filter((vm) => isCodexVm(vm))
  const effective = openaiPolicy(quota)
  const title =
    dialog === 'gates'
      ? t('quota.gates')
      : dialog === 'concurrency'
        ? t('quota.concurrency')
        : dialog === 'rpm'
          ? t('quota.requestRate')
          : dialog === 'sessions'
            ? t('quota.sessions')
            : t('quota.accountOverrides')

  return (
    <>
      <PaneSection
        icon={Gauge}
        title={t('quota.schedulingSlots')}
        desc={t('quota.gptAccounts', { count: Number(items.length) })}
      >
        <div className='grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4'>
          <QuotaSummary
            icon={Clock3}
            title={t('quota.gates')}
            value={`${Math.round(effective.limit_5h * 100)}% / ${Math.round(effective.limit_7d * 100)}%`}
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
            value={String(effective.max_concurrency)}
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
            value={formatRpm(effective.max_rpm)}
            desc={t('quota.queueNotSwitch')}
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.rpm = node
            }}
            disabled={saving}
            onClick={() => openDialog('rpm')}
          />
          <QuotaSummary
            icon={MessageSquare}
            title={t('quota.sessions')}
            value={
              effective.max_sessions
                ? String(effective.max_sessions)
                : t('unlimited')
            }
            desc={t('quota.sessionIdleHint')}
            pending={pending}
            buttonRef={(node) => {
              triggerRefs.current.sessions = node
            }}
            disabled={saving}
            onClick={() => openDialog('sessions')}
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
          className={quotaDialogClass(dialog ?? '', false)}
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
              <OpenAIGates
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'concurrency' ? (
              <OpenAICapacity
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'rpm' ? (
              <OpenAIRpm
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'sessions' ? (
              <OpenAISessions
                policy={draft}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            ) : null}
            {dialog === 'details' ? (
              <PlatformAccountList
                platform='openai'
                items={items}
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
    </>
  )
}

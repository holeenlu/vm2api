import { useEffect, useRef, useState } from 'react'
import { Clock3, Link2, Radio, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fmtDuration } from '@/lib/format'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { withCurrent } from '@/features/vm/scheduling-steps'

type Obj = Record<string, unknown>
type StickyDialog = 'binding' | 'ttl' | 'outbound'

type StickyPaneProps = {
  value: Obj
  onChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
}

function SummaryButton({
  icon: Icon,
  title,
  value,
  desc,
  pending,
  buttonRef,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  title: string
  value: string
  desc: string
  pending: boolean
  buttonRef: (node: HTMLButtonElement | null) => void
  disabled: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('settings')

  return (
    <Button
      ref={buttonRef}
      type='button'
      variant='outline'
      disabled={disabled}
      onClick={onClick}
      className='h-auto min-h-24 w-full min-w-0 justify-start gap-3 px-4 py-3 text-left'
    >
      <Icon className='size-4 shrink-0 text-primary' aria-hidden />
      <span className='min-w-0 flex-1'>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{title}</span>
          {pending ? (
            <span className='shrink-0 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] text-[color:var(--status-caution)]'>
              {t('pendingSave')}
            </span>
          ) : null}
        </span>
        <span className='block truncate text-sm font-semibold'>{value}</span>
        <span className='block truncate text-xs font-normal text-muted-foreground'>
          {desc}
        </span>
      </span>
    </Button>
  )
}

export function StickyPane({
  value: sticky,
  onChange,
  saving = false,
  pending = false,
}: StickyPaneProps) {
  const { t } = useTranslation('settings')

  const [dialog, setDialog] = useState<StickyDialog | null>(null)
  const [local, setLocal] = useState<Obj>({ ...sticky })
  const triggerRefs = useRef<
    Partial<Record<StickyDialog, HTMLButtonElement | null>>
  >({})
  const previousDialog = useRef<StickyDialog | null>(null)

  useEffect(() => {
    if (previousDialog.current && !dialog) {
      triggerRefs.current[previousDialog.current]?.focus()
    }
    previousDialog.current = dialog
  }, [dialog])

  const open = (kind: StickyDialog) => {
    if (saving) return
    setLocal({ ...sticky })
    setDialog(kind)
  }
  const close = () => {
    if (!saving) setDialog(null)
  }
  const apply = () => {
    if (!dialog || saving) return
    if (dialog === 'binding') {
      onChange({ enabled: local.enabled !== false })
    } else if (dialog === 'ttl') {
      onChange({ ttl_seconds: Number(local.ttl_seconds ?? 86400) })
    } else {
      onChange({
        outbound_session: String(local.outbound_session || 'rebuild'),
      })
    }
    setDialog(null)
  }
  const enabled = sticky.enabled !== false
  const ttl = Number(sticky.ttl_seconds ?? 86400)
  const outbound = String(sticky.outbound_session || 'rebuild')
  const ttlOptions = withCurrent(
    [3600, 21600, 86400, 604800, 2592000].map((seconds): [number, string] => [
      seconds,
      fmtDuration(seconds * 1000),
    ]),
    ttl
  )

  return (
    <div className='space-y-4'>
      <div>
        <h2 className='text-base font-semibold'>{t('nav.sticky')}</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          {t('sticky.description')}
        </p>
      </div>
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
        <div>
          <SummaryButton
            icon={Link2}
            title={t('sticky.binding')}
            value={enabled ? t('enabled') : t('disabled')}
            desc={t('sticky.bindingHelp')}
            pending={pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.binding = node
            }}
            onClick={() => open('binding')}
          />
        </div>
        <div>
          <SummaryButton
            icon={Clock3}
            title={t('sticky.bindingTtl')}
            value={fmtDuration(ttl * 1000)}
            desc={t('sticky.bindingTtlHelp')}
            pending={pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.ttl = node
            }}
            onClick={() => open('ttl')}
          />
        </div>
      </div>
      <Button
        type='button'
        variant='ghost'
        disabled={saving}
        ref={(node) => {
          triggerRefs.current.outbound = node
        }}
        className='h-auto min-h-11 w-full justify-start gap-2 px-2 py-2 text-left'
        onClick={() => open('outbound')}
      >
        <Radio className='size-4 text-muted-foreground' aria-hidden />
        <span>
          <span className='block text-sm font-medium'>
            {
              <>
                {t('sticky.outboundSummary', {
                  mode: t(
                    outbound === 'passthrough'
                      ? 'sticky.passthrough'
                      : 'sticky.rebuild'
                  ),
                })}
                {pending ? (
                  <span className='ml-2 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] font-normal text-[color:var(--status-caution)]'>
                    {t('pendingSave')}
                  </span>
                ) : null}
              </>
            }
          </span>
          <span className='block text-xs font-normal text-muted-foreground'>
            {t('sticky.identityScope')}
          </span>
        </span>
      </Button>
      <div className='rounded-lg border bg-muted/20 p-4 text-sm'>
        <h3 className='font-medium'>{t('sticky.platformFlow')}</h3>
        <p className='mt-2 leading-6 text-muted-foreground'>
          {t('sticky.platformFlowHelp')}
        </p>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !saving) close()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg'
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === 'binding'
                ? t('sticky.binding')
                : dialog === 'ttl'
                  ? t('sticky.bindingTtl')
                  : t('sticky.outboundSession')}
            </DialogTitle>
            <DialogDescription>{t('sticky.draftHelp')}</DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {dialog === 'binding' ? (
              <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
                <div>
                  <Label htmlFor='sticky-dialog-enabled'>
                    {t('sticky.enableBinding')}
                  </Label>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    {t('sticky.enableBindingHelp')}
                  </p>
                </div>
                <Switch
                  id='sticky-dialog-enabled'
                  checked={local.enabled !== false}
                  onCheckedChange={(enabled) =>
                    setLocal((current) => ({ ...current, enabled }))
                  }
                />
              </div>
            ) : null}
            {dialog === 'ttl' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-ttl'>
                  {t('sticky.bindingTtl')}
                </Label>
                <Select
                  value={String(local.ttl_seconds ?? ttl)}
                  onValueChange={(next) =>
                    setLocal((current) => ({
                      ...current,
                      ttl_seconds: Number(next),
                    }))
                  }
                >
                  <SelectTrigger id='sticky-dialog-ttl' className='min-h-11'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ttlOptions.map(([seconds, label]) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {dialog === 'outbound' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-outbound'>
                  {t('sticky.outboundIdentity')}
                </Label>
                <Select
                  value={String(local.outbound_session || 'rebuild')}
                  onValueChange={(outbound_session) =>
                    setLocal((current) => ({
                      ...current,
                      outbound_session,
                    }))
                  }
                >
                  <SelectTrigger
                    id='sticky-dialog-outbound'
                    className='min-h-11'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='rebuild'>
                      {t('sticky.rebuild')}
                    </SelectItem>
                    <SelectItem value='passthrough'>
                      {t('sticky.passthrough')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className='text-xs leading-5 text-muted-foreground'>
                  {t('sticky.outboundHelp')}
                </p>
              </div>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={close}
            >
              {t('cancel')}
            </Button>
            <Button
              type='button'
              disabled={saving}
              className='min-h-11'
              onClick={apply}
            >
              {t('applyDraft')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

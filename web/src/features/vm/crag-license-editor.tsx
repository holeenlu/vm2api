import { useId } from 'react'
import { t } from '@/i18n'
import type { CragLicenseResponse, CragLicenseStatus } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

const LICENSE_CODES = [
  'license_required',
  'license_expired',
  'license_not_yet_valid',
  'license_invalid',
  'license_binding_mismatch',
  'license_unconfigured',
]
const LICENSE_STATUSES: readonly CragLicenseStatus['status'][] = [
  'unlicensed',
  'valid',
  'expired',
  'not_yet_valid',
  'invalid',
  'unconfigured',
]
const LICENSE_TERMS = ['1m', '6m', '1y']

function licenseMessage(code?: string): string | undefined {
  return code && LICENSE_CODES.includes(code)
    ? t(`vm:cragLicense.messages.${code}`)
    : undefined
}

const statusCodes: Record<CragLicenseStatus['status'], string> = {
  unlicensed: 'license_required',
  valid: '',
  expired: 'license_expired',
  not_yet_valid: 'license_not_yet_valid',
  invalid: 'license_invalid',
  unconfigured: 'license_unconfigured',
}

export function cragLicenseErrorMessage(error: unknown) {
  if (isApiError(error)) {
    const message = licenseMessage(error.code)
    if (message) return message
    if (error.status === 401) return t('vm:cragLicense.sessionExpired')
    if (error.status === 403) return t('vm:cragLicense.forbidden')
  }
  return t('vm:cragLicense.requestFailed')
}

function utcTimestamp(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

export function CragLicenseSummary({
  license,
}: {
  license: CragLicenseStatus
}) {
  const { t: tVm } = useTranslation('vm')
  return (
    <dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2'>
      <div>
        <dt className='text-xs text-muted-foreground'>
          {tVm('vm:cragLicense.summaryTitle')}
        </dt>
        <dd className='mt-1 font-medium'>
          {LICENSE_STATUSES.includes(license.status)
            ? tVm(`vm:cragLicense.status.${license.status}`)
            : tVm('vm:cragLicense.unknownStatus')}
        </dd>
      </div>
      <div>
        <dt className='text-xs text-muted-foreground'>
          {tVm('vm:cragLicense.issuedTerm')}
        </dt>
        <dd className='mt-1'>
          {license.term && LICENSE_TERMS.includes(license.term)
            ? tVm(`vm:cragLicense.term.${license.term}`)
            : '—'}
        </dd>
      </div>
      <div>
        <dt className='text-xs text-muted-foreground'>
          {tVm('vm:cragLicense.notBefore')}
        </dt>
        <dd className='mt-1 break-words tabular-nums'>
          {utcTimestamp(license.not_before)}
        </dd>
      </div>
      <div>
        <dt className='text-xs text-muted-foreground'>
          {tVm('vm:cragLicense.expiresAt')}
        </dt>
        <dd className='mt-1 break-words tabular-nums'>
          {utcTimestamp(license.expires_at)}
        </dd>
      </div>
    </dl>
  )
}

export function CragLicenseEditor({
  data,
  loading,
  loadError,
  activationError,
  registrationCode,
  activating,
  onChange,
  onRefresh,
  onActivate,
  onClose,
}: {
  data?: CragLicenseResponse
  loading: boolean
  loadError: unknown
  activationError: unknown
  registrationCode: string
  activating: boolean
  onChange: (code: string) => void
  onRefresh: () => void
  onActivate: () => void
  onClose: () => void
}) {
  const { t: tVm } = useTranslation('vm')
  const formId = useId()
  const license = data?.license
  const statusMessage =
    license && !license.valid
      ? licenseMessage(license.code) ||
        licenseMessage(statusCodes[license.status]) ||
        tVm('vm:cragLicense.statusUnknownHelp')
      : null
  const busy = loading || activating

  return (
    <section
      className='min-w-0 space-y-4 border-t pt-4'
      aria-label={tVm('vm:cragLicense.manageAria')}
      aria-busy={busy}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h4 className='text-sm font-medium'>{tVm('vm:cragLicense.heading')}</h4>
        <div className='flex gap-2'>
          <Button
            type='button'
            variant='ghost'
            disabled={busy}
            onClick={onRefresh}
          >
            {loading
              ? tVm('vm:cragLicense.loading')
              : tVm('vm:cragLicense.refresh')}
          </Button>
          <Button
            type='button'
            variant='ghost'
            disabled={busy}
            onClick={onClose}
          >
            {tVm('vm:cragLicense.collapse')}
          </Button>
        </div>
      </div>
      {loading && !data ? (
        <div role='status' className='space-y-2'>
          <span className='text-sm text-muted-foreground'>
            {tVm('vm:cragLicense.loadingDetails')}
          </span>
          <Skeleton className='h-16 w-full' />
        </div>
      ) : null}
      {loadError ? (
        <p role='alert' className='text-sm text-destructive'>
          {cragLicenseErrorMessage(loadError)}
          {data ? ` ${tVm('vm:cragLicense.staleData')}` : ''}
        </p>
      ) : null}
      {license ? <CragLicenseSummary license={license} /> : null}
      {statusMessage ? (
        <p
          role='status'
          className='text-sm leading-relaxed text-muted-foreground'
        >
          {statusMessage}
        </p>
      ) : null}
      {data?.machine_code ? (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor={`${formId}-machine`}>
              {tVm('vm:cragLicense.machineCode')}
            </Label>
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.machine_code)
                  toast.success(tVm('vm:cragLicense.copied'))
                } catch {
                  toast.error(tVm('vm:cragLicense.copyFailed'))
                }
              }}
            >
              {tVm('vm:cragLicense.copy')}
            </Button>
          </div>
          <Textarea
            id={`${formId}-machine`}
            readOnly
            rows={3}
            value={data.machine_code}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className='max-h-36 resize-y font-mono text-sm break-all'
            aria-describedby={`${formId}-machine-help`}
          />
          <p
            id={`${formId}-machine-help`}
            className='text-xs leading-relaxed text-muted-foreground'
          >
            {tVm('vm:cragLicense.machineHelp')}
          </p>
        </div>
      ) : null}
      <form
        className='space-y-3'
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && registrationCode.trim() && data && !loadError)
            onActivate()
        }}
      >
        <div className='space-y-2'>
          <Label htmlFor={`${formId}-registration`}>
            {license?.valid
              ? tVm('vm:cragLicense.replaceCode')
              : tVm('vm:cragLicense.registrationCode')}
          </Label>
          <Textarea
            id={`${formId}-registration`}
            rows={4}
            value={registrationCode}
            onChange={(event) => onChange(event.target.value)}
            disabled={busy || !data || !!loadError}
            autoComplete='off'
            autoCapitalize='none'
            spellCheck={false}
            className='max-h-48 resize-y font-mono text-sm break-all'
            aria-invalid={!!activationError}
            aria-describedby={`${formId}-registration-help${activationError ? ` ${formId}-error` : ''}`}
          />
          <p
            id={`${formId}-registration-help`}
            className='text-xs leading-relaxed text-muted-foreground'
          >
            {tVm('vm:cragLicense.registrationHelp')}
          </p>
        </div>
        {activationError ? (
          <p
            id={`${formId}-error`}
            role='alert'
            className='text-sm text-destructive'
          >
            {cragLicenseErrorMessage(activationError)}
          </p>
        ) : null}
        <Button
          type='submit'
          disabled={busy || !registrationCode.trim() || !data || !!loadError}
        >
          {activating
            ? tVm('vm:cragLicense.activating')
            : license?.valid
              ? tVm('vm:cragLicense.replace')
              : tVm('vm:cragLicense.activate')}
        </Button>
      </form>
    </section>
  )
}

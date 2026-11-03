import { t as tVm } from '@/i18n'

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip'

export type CheckId =
  | 'record'
  | 'credential'
  | 'node_link'
  | 'relay'
  | 'egress'
  | 'container'
  | 'kernel'
  | 'watchdog'
  | 'schedule'

export type DiagnosisCheck = {
  id: CheckId
  label: string
  status: CheckStatus
  code: string | null
  message: string
  detail?: Record<string, unknown>
}

export type Diagnosis = {
  vm_id: string
  checked_at: string
  ok: boolean
  engine: string | null
  placement: 'local' | 'node'
  first_failure: CheckId | null
  checks: DiagnosisCheck[]
}

export type RecoverStep = {
  id: 'node_link' | 'relay' | 'stop' | 'start' | 'watchdog_reset'
  label: string
  ok: boolean
  code: string | null
  message: string
  ms: number
}

export type RecoverReport = {
  vm_id: string
  ok: boolean
  duration_ms: number
  steps: RecoverStep[]
  diagnosis: Diagnosis
}

export function firstFailingCheck(diagnosis: Diagnosis): DiagnosisCheck | null {
  if (diagnosis.ok) return null
  return (
    diagnosis.checks.find((c) => c.id === diagnosis.first_failure) ??
    diagnosis.checks.find((c) => c.status === 'error' || c.status === 'warn') ??
    null
  )
}

export function firstRecoverFailure(report: RecoverReport): {
  code: string | null
  message: string
} {
  const step = report.steps.find((s) => !s.ok)
  if (step) return { code: step.code, message: step.message }
  const check = firstFailingCheck(report.diagnosis)
  if (check) return { code: check.code, message: check.message }
  return { code: null, message: tVm('vm:vmRecoveryTypes.recoveryIncomplete') }
}

/** Stable check IDs are protocol data; labels are resolved only for display. */
const CHECK_LABEL_KEYS: Record<CheckId, string> = {
  record: 'vm:recoveryChecks.record',
  credential: 'vm:recoveryChecks.credential',
  node_link: 'vm:recoveryChecks.nodeLink',
  relay: 'vm:recoveryChecks.relay',
  egress: 'vm:recoveryChecks.egress',
  container: 'vm:recoveryChecks.container',
  kernel: 'vm:recoveryChecks.kernel',
  watchdog: 'vm:recoveryChecks.watchdog',
  schedule: 'vm:recoveryChecks.schedule',
}
const STEP_LABEL_KEYS: Record<RecoverStep['id'], string> = {
  node_link: 'vm:recoveryChecks.nodeLink',
  relay: 'vm:recoveryChecks.relay',
  stop: 'vm:recoverySteps.stop',
  start: 'vm:recoverySteps.start',
  watchdog_reset: 'vm:recoverySteps.watchdogReset',
}
export function diagnosisCheckLabel(
  check: Pick<DiagnosisCheck, 'id' | 'label'>
): string {
  const key = CHECK_LABEL_KEYS[check.id]
  return key ? tVm(key) : check.label
}
export function recoveryStepLabel(
  step: Pick<RecoverStep, 'id' | 'label'>
): string {
  const key = STEP_LABEL_KEYS[step.id]
  return key ? tVm(key) : step.label
}

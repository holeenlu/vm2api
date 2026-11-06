import { t } from '@/i18n'
import { memoryBytes } from '@/features/cluster/model'

const MEMORY = ['256m', '512m', '1g', '2g', '4g', '8g', '16g']

export function migrationMemoryOptions(current: unknown): string[] {
  const bytes = memoryBytes(current) || 2 * 1024 ** 3
  return MEMORY.filter((m) => (memoryBytes(m) || 0) >= bytes)
}

export function migrationPhase(phase: string): string {
  const labels: Record<string, string> = {
    queued: 'cluster:migration.phase.queued',
    preflight: 'cluster:migration.phase.preflight',
    draining: 'cluster:migration.phase.draining',
    stopping: 'cluster:migration.phase.stopping',
    copying: 'cluster:migration.phase.copying',
    switching: 'cluster:migration.phase.switching',
    starting: 'cluster:migration.phase.starting',
    verifying: 'cluster:migration.phase.verifying',
    cleanup: 'cluster:migration.phase.cleanup',
    done: 'cluster:migration.phase.done',
    rolling_back: 'cluster:migration.phase.rollingBack',
    rolled_back: 'cluster:migration.phase.rolledBack',
    rollback_failed: 'cluster:migration.phase.rollbackFailed',
    failed: 'cluster:migration.phase.failed',
  }
  return labels[phase] ? t(labels[phase]) : phase
}

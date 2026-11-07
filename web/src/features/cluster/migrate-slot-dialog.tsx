import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CLUSTER_NODES_KEY } from '@/features/cluster/queries'
import {
  migrationMemoryOptions,
  migrationPhase,
} from '@/features/cluster/slot-migration'

function migrationPath(id: string) {
  return `/api/panel/vms/${encodeURIComponent(id)}/migration`
}

type MigrationJob = {
  id: string
  status: 'running' | 'done' | 'failed' | 'needs_attention'
  phase: string
  error?: string
  warning?: string
  backup_directory?: string | null
  copied_bytes?: number
}

export function MigrateSlotDialog({
  vm,
  nodes,
  onClose,
}: {
  vm: Vm | null
  nodes: ClusterApiNode[]
  onClose: () => void
}) {
  const { t } = useTranslation('cluster')
  return (
    <Dialog
      open={!!vm}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{t('migration.title')}</DialogTitle>
          <DialogDescription>{t('migration.description')}</DialogDescription>
        </DialogHeader>
        {vm ? <MigrationForm key={vm.id} vm={vm} nodes={nodes} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function MigrationForm({ vm, nodes }: { vm: Vm; nodes: ClusterApiNode[] }) {
  const { t } = useTranslation('cluster')
  const qc = useQueryClient()
  const [target, setTarget] = useState(vm.node_id || '')
  const [memory, setMemory] = useState(vm.machine?.memory || '2g')
  const [confirmed, setConfirmed] = useState(false)
  const key = panelQueryKeys.vmMigration(vm.id)
  const job = useQuery({
    queryKey: key,
    queryFn: () => api<MigrationJob | null>(migrationPath(vm.id)),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false),
    refetchOnWindowFocus: true,
    retry: false,
  })
  const start = useMutation({
    mutationFn: () =>
      api<MigrationJob>(migrationPath(vm.id), {
        method: 'POST',
        body: JSON.stringify({ target_node_id: target, memory }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(key, data)
      setConfirmed(false)
    },
  })
  const status = job.data?.status
  const pending = status === 'running' || start.isPending
  const blocked =
    pending || status === 'needs_attention' || job.isPending || !!job.error
  useEffect(() => {
    if (!status || status === 'running') return
    qc.invalidateQueries({ queryKey: panelQueryKeys.dashboard() })
    qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
    qc.invalidateQueries({ queryKey: panelQueryKeys.vms() })
  }, [status, job.data?.id, qc])
  const eligible = nodes.filter(
    (n) => n.platform !== 'darwin' && n.link.state === 'ready'
  )
  const unchanged = target === vm.node_id && memory === vm.machine?.memory
  return (
    <div className='space-y-4 text-sm'>
      <p className='font-medium'>{vm.name || vm.id}</p>
      <label className='grid gap-1.5'>
        {t('migration.targetNode')}
        <select
          aria-label={t('migration.targetNode')}
          className='h-9 rounded-md border bg-background px-2'
          value={target}
          disabled={blocked}
          onChange={(e) => {
            setTarget(e.target.value)
            setConfirmed(false)
          }}
        >
          <option value='' disabled>
            {t('migration.selectNode')}
          </option>
          {eligible.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id === vm.node_id
                ? t('migration.sameNode', { name: n.label || n.id })
                : n.label || n.id}
            </option>
          ))}
        </select>
      </label>
      <label className='grid gap-1.5'>
        {t('migration.memory')}
        <select
          aria-label={t('migration.memory')}
          className='h-9 rounded-md border bg-background px-2'
          value={memory}
          disabled={blocked}
          onChange={(e) => {
            setMemory(e.target.value)
            setConfirmed(false)
          }}
        >
          {migrationMemoryOptions(vm.machine?.memory).map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <p className='text-xs leading-relaxed text-muted-foreground'>
        {t('migration.scopeHelp')}
      </p>
      <label className='flex items-start gap-2'>
        <input
          type='checkbox'
          className='mt-1'
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t('migration.confirm')}
      </label>
      {job.data ? (
        <div role='status' className='space-y-1 rounded-md border p-3'>
          <p>{migrationPhase(job.data.phase)}</p>
          {job.data.copied_bytes != null ? (
            <p className='text-xs text-muted-foreground'>
              {t('migration.copied', {
                size: (job.data.copied_bytes / 1024 ** 2).toFixed(1),
              })}
            </p>
          ) : null}
          {job.data.error ? (
            <p className='text-destructive'>{job.data.error}</p>
          ) : null}
          {job.data.warning ? (
            <p className='text-amber-600'>{job.data.warning}</p>
          ) : null}
          {job.data.backup_directory ? (
            <p className='text-xs break-all text-muted-foreground'>
              {t('migration.backup', { path: job.data.backup_directory })}
            </p>
          ) : null}
          {pending ? (
            <p className='text-xs text-muted-foreground'>
              {t('migration.closeHint')}
            </p>
          ) : null}
        </div>
      ) : null}
      {start.error || job.error ? (
        <p role='alert' className='text-destructive'>
          {(start.error || job.error)?.message}
        </p>
      ) : null}
      <Button
        disabled={
          blocked ||
          !target ||
          !confirmed ||
          unchanged ||
          vm.status !== 'running'
        }
        onClick={() => start.mutate()}
      >
        {pending ? t('migration.processing') : t('migration.run')}
      </Button>
    </div>
  )
}

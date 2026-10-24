import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ChoiceTiles } from '@/components/choice-tiles'
import { meQueryOptions } from '@/features/auth/queries'
import {
  dashboardQueryOptions,
  usageQueryOptions,
} from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'
import type { WrapSyncReport } from '@/features/wrap/queries'
import {
  syncReportFromError,
  syncReportSummary,
} from '@/features/wrap/sync-report'

type FleetAction = 'roll' | 'collect'

type FleetReport = {
  action?: FleetAction
  total?: number
  ok_count?: number
  items?: { id?: string; ok?: boolean }[]
}

type ProbeItem = {
  vm_id?: string
  id?: string
  ok?: boolean
  error?: unknown
}

function errorText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const nested = rec.error as Record<string, unknown> | undefined
    return String(
      rec.message ||
        nested?.message ||
        rec.code ||
        nested?.code ||
        JSON.stringify(value)
    )
  }
  return String(value)
}

async function invalidateFleet(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: usageQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
    qc.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey[0] === 'panel' &&
        q.queryKey[1] === 'vm',
    }),
  ])
}

export function FleetActions() {
  const { t } = useTranslation('fleet')

  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  // 额度探测、全槽更新、重装内核都是管理员接口，其它角色点了只会 403。
  const canManage = me.data?.role === 'admin'
  const [fleetOpen, setFleetOpen] = useState(false)
  const [kernelOpen, setKernelOpen] = useState(false)
  const [kernelMode, setKernelMode] = useState<'keep' | 'traits'>('keep')
  const refresh = useMutation({
    mutationFn: () => invalidateFleet(qc),
    onSuccess: () => toast.success(t('fleet:refreshed')),
  })
  const probe = useMutation({
    mutationFn: () =>
      api<{ items?: ProbeItem[] }>('/api/panel/probe', {
        method: 'POST',
        body: JSON.stringify({ hop: true, force: true }),
      }),
    onSuccess: async (data) => {
      const items = data.items || []
      const ok = items.filter((x) => x && x.ok).length
      const failed = items.filter((x) => x && !x.ok)
      if (failed.length) {
        const reasons = failed
          .slice(0, 2)
          .map(
            (x) =>
              `${x.vm_id || x.id || '?'} ${errorText(x.error) || t('fleet:failed')}`
          )
          .join('; ')
        toast.error(
          t('fleet:probeFailure', {
            ok,
            total: items.length,
            count: failed.length,
            reasons,
          })
        )
      } else {
        toast.success(t('fleet:probeSuccess', { ok: ok, total: items.length }))
      }
      await invalidateFleet(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const fleet = useMutation({
    mutationFn: (action: FleetAction) =>
      api<FleetReport>('/api/panel/vms/fleet-update', {
        method: 'POST',
        body: JSON.stringify({ action, concurrency: 4 }),
      }),
    onSuccess: async (report) => {
      const items = report.items || []
      const total = report.total ?? items.length
      const ok = report.ok_count ?? items.filter((x) => x?.ok).length
      const failed = items.filter((x) => x && !x.ok).map((x) => x.id || '?')
      const label =
        report.action === 'collect'
          ? t('fleet:collectOnly')
          : t('fleet:reloadCollect')
      if (failed.length) {
        toast.error(
          t('fleet:actionFailed', {
            action: label,
            ok: ok,
            total: total,
            failures: failed.join(', '),
          })
        )
      } else {
        toast.success(t('fleet:actionSuccess', { action: label, ok, total }))
      }
      setFleetOpen(false)
      await invalidateFleet(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const wrapSync = useMutation({
    mutationFn: (mode: 'keep' | 'traits') =>
      api<WrapSyncReport>('/api/panel/wrap-cli/sync', {
        method: 'POST',
        body: JSON.stringify({ restart: true, mode }),
      }),
    onSuccess: (report) => {
      const total = report.total ?? 0
      const ok = report.ok_count ?? 0
      const kernelFail = wrapSyncKernelFails(report.items)
      if ((report.failed_count || 0) > 0) {
        toast.error(
          t('fleet:kernelSummary', { summary: syncReportSummary(report) })
        )
      } else if (kernelFail > 0) {
        toast.error(
          t('fleet:kernelProcessFailure', {
            ok: ok,
            total: total,
            count: kernelFail,
          })
        )
      } else {
        toast.success(t('fleet:kernelSuccess', { ok, total }))
      }
      setKernelOpen(false)
    },
    onError: (error: Error) => {
      // 部分槽失败时网关回 400，正文仍是逐槽报告。
      const report = syncReportFromError(error)
      toast.error(
        report
          ? t('fleet:kernelSummary', { summary: syncReportSummary(report) })
          : error.message
      )
    },
    onSettled: () => invalidateFleet(qc),
  })

  return (
    <div className='hidden items-center gap-2 md:flex'>
      <Button
        variant='outline'
        size='sm'
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
        loading={refresh.isPending}
      >
        {t('fleet:refresh')}
      </Button>
      {canManage ? (
        <>
          <Button
            variant='outline'
            size='sm'
            onClick={() => probe.mutate()}
            disabled={probe.isPending}
            loading={probe.isPending}
          >
            {t('fleet:probeQuota')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setFleetOpen(true)}
            disabled={fleet.isPending}
            loading={fleet.isPending}
          >
            {t('fleet:updateAll')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => setKernelOpen(true)}
            disabled={wrapSync.isPending}
            loading={wrapSync.isPending}
          >
            {t('fleet:reinstallKernel')}
          </Button>
        </>
      ) : null}

      <Dialog open={fleetOpen} onOpenChange={setFleetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fleet:updateAll')}</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>
            {t('fleet:reinstallHelp')}
          </p>
          <p className='text-sm text-muted-foreground'>
            {t('fleet:updateHelp')}
          </p>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setFleetOpen(false)}
              disabled={fleet.isPending}
            >
              {t('fleet:cancel')}
            </Button>
            <Button
              variant='outline'
              disabled={fleet.isPending}
              loading={fleet.isPending}
              onClick={() => fleet.mutate('collect')}
            >
              {t('fleet:collect')}
            </Button>
            <Button
              disabled={fleet.isPending}
              loading={fleet.isPending}
              onClick={() => fleet.mutate('roll')}
            >
              {t('fleet:reloadCollect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={kernelOpen} onOpenChange={setKernelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fleet:reinstallKernel')}</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>
            {t('fleet:kernelScope')}
          </p>
          <ChoiceTiles
            label={t('fleet:updateMode')}
            value={kernelMode}
            onChange={setKernelMode}
            choices={[
              {
                value: 'keep',
                title: t('fleet:preserveData'),
                detail: t('fleet:preserveHelp'),
              },
              {
                value: 'traits',
                title: t('fleet:newFingerprint'),
                detail: t('fleet:newFingerprintHelp'),
              },
            ]}
          />
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setKernelOpen(false)}
              disabled={wrapSync.isPending}
            >
              {t('fleet:cancel')}
            </Button>
            <Button
              disabled={wrapSync.isPending}
              loading={wrapSync.isPending}
              variant={kernelMode === 'traits' ? 'destructive' : 'default'}
              onClick={() => wrapSync.mutate(kernelMode)}
            >
              {kernelMode === 'keep'
                ? t('fleet:preserveData')
                : t('fleet:newFingerprint')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

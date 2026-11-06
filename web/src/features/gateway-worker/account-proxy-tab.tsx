import { useState } from 'react'
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { proxyIsLocal } from '@/features/proxies/proxy-sort'
import { useRefreshProxies } from '@/features/proxies/queries'
import { VmProxyTab } from '@/features/vm/detail-proxy-tab'
import { pickBindTarget } from '@/features/vm/vm-perms'
import {
  accountBase,
  accountQueryKey,
  type GatewayAccount,
} from './accounts-model'

type Job = {
  key: string
  run: () => Promise<unknown>
  done?: (data: unknown) => void
}

/**
 * Gateway 账号的「代理」页签：与 VM 槽位同一张卡片（健康、延迟、出口地理、测通 / 测地理、换绑）。
 * 账号必须有出站代理，所以没有解绑和自动分配；池外的手填地址可一键加入代理池后再检测。
 */
export function GatewayAccountProxyTab({
  account,
  vm,
  pool,
  canManage,
}: {
  account: GatewayAccount
  vm: Vm
  pool: VmProxySnap[]
  canManage: boolean
}) {
  const { t } = useTranslation(['common', 'vm'])
  const qc = useQueryClient()
  const refreshProxies = useRefreshProxies()
  const proxy = vm.proxy || {}
  const boundId = proxy.id || ''
  const inline = !boundId && !!proxy.host
  // 与编辑对话框的可选代理同一范围：启用、平台自有、非本机出口。
  const free = pool.filter(
    (p) =>
      p.id &&
      p.enabled &&
      !p.vendor_id &&
      !proxyIsLocal(p) &&
      p.status !== 'dead' &&
      !p.blocked_reason
  )
  const [bindId, setBindId] = useState('')
  const bindTarget = pickBindTarget(bindId, free)
  const jobKey = ['panel', 'gateway-proxy-job', account.id] as const
  const job = useMutation({
    mutationKey: jobKey,
    mutationFn: (j: Job) => j.run(),
    onSuccess: async (data, j) => {
      j.done?.(data)
      await Promise.all([
        qc.invalidateQueries({ queryKey: accountQueryKey }),
        refreshProxies(),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pendingKeys = useMutationState({
    filters: { mutationKey: jobKey, status: 'pending' },
    select: (m) => (m.state.variables as Job | undefined)?.key ?? '',
  })
  const busy = (key: string) => pendingKeys.includes(key)
  const runJob = (j: Job) => {
    if (!busy(j.key)) job.mutate(j)
  }
  const saved = (data: unknown) => {
    if ((data as { projection_pending?: boolean })?.projection_pending)
      toast.warning(t('codexProjectionPending'))
    else toast.success(t('vm:detailAccountTab.bound'))
  }

  return (
    <VmProxyTab
      vm={vm}
      proxy={proxy}
      boundId={boundId}
      free={free}
      pool={pool}
      bindId={bindTarget}
      canManage={canManage}
      busy={busy}
      onBindIdChange={setBindId}
      description={t('codexProxyDescription')}
      health={inline ? null : undefined}
      compareTimezone={false}
      onBind={() =>
        runJob({
          key: 'proxy:bind',
          run: () =>
            api(`${accountBase}/${encodeURIComponent(account.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ proxy_id: bindTarget }),
            }),
          done: saved,
        })
      }
      onProbe={() =>
        runJob({
          key: 'proxy:probe',
          run: () =>
            api(`/api/panel/proxies/${encodeURIComponent(boundId)}/probe`, {
              method: 'POST',
            }),
          done: () => toast.success(t('vm:detailPage.probeCompleted')),
        })
      }
      onGeo={() =>
        runJob({
          key: 'proxy:geo',
          run: () =>
            api(`/api/panel/proxies/${encodeURIComponent(boundId)}/geo`, {
              method: 'POST',
            }),
          done: (data) => {
            const geo = (
              data as {
                geo?: { country?: string | null; timezone?: string | null }
              }
            )?.geo
            const where = [geo?.country, geo?.timezone]
              .filter(Boolean)
              .join(' · ')
            toast.success(
              where
                ? t('vm:detailPage.egressLocation', { where })
                : t('vm:detailPage.checked')
            )
          },
        })
      }
      notice={
        inline ? (
          <div className='flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm'>
            <span className='min-w-0 flex-1 text-muted-foreground'>
              {t('codexProxyNotPooled')}
            </span>
            {canManage && !account.vendor_id ? (
              <Button
                size='sm'
                loading={busy('proxy:pool')}
                onClick={() =>
                  runJob({
                    key: 'proxy:pool',
                    run: () =>
                      api(
                        `${accountBase}/${encodeURIComponent(account.id)}/pool-proxy`,
                        { method: 'POST' }
                      ),
                    done: () => toast.success(t('codexProxyPooled')),
                  })
                }
              >
                {t('codexPoolProxy')}
              </Button>
            ) : null}
          </div>
        ) : null
      }
    />
  )
}

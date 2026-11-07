import type { QueryClient } from '@tanstack/react-query'
import type {
  OfficialCcBootstrapPayload,
  SetupTokenSession,
  TestModelsPayload,
  VmCreateOptions,
  VmCredentialResponse,
  VmDetailPayload,
  VmSeedSettings,
  VmsListResponse,
} from '@/types/panel-vm'
import { api, getVmCragLicense } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { queryOptions } from '@/lib/query-options'

/** 创建表单默认规格 + 本机 KVM 能力，供资源管理角色使用。 */
export function vmCreateOptionsQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.vmCreateOptions(),
    queryFn: () => api<VmCreateOptions>('/api/panel/vms/create-options'),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function vmsListQueryOptions(refetchInterval?: number) {
  return queryOptions({
    queryKey: panelQueryKeys.vms(),
    queryFn: async () => {
      const data = await api<VmsListResponse>('/api/panel/vms')
      return { items: data.items || [], pool_queue: data.pool_queue }
    },
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}

export function vmQueryOptions(id: string) {
  return queryOptions({
    queryKey: panelQueryKeys.vm(id),
    queryFn: () =>
      api<VmDetailPayload>(`/api/panel/vms/${encodeURIComponent(id)}`),
  })
}

export function vmCragLicenseQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'crag-license'] as const,
    queryFn: () => getVmCragLicense(id),
    staleTime: 0,
    retry: false,
  })
}

export function vmSeedQueryOptions(id: string) {
  return queryOptions({
    queryKey: panelQueryKeys.vmSeed(id),
    queryFn: () =>
      api<VmSeedSettings>(
        `/api/panel/vms/${encodeURIComponent(id)}/seed-settings`
      ),
    refetchInterval: false,
  })
}

/** Upload audit lines only — does not share the seed form query key. */
export function vmSeedUploadLogQueryOptions(id: string) {
  return queryOptions({
    queryKey: panelQueryKeys.vmSeedUploadLog(id),
    queryFn: async () => {
      const data = await api<VmSeedSettings>(
        `/api/panel/vms/${encodeURIComponent(id)}/seed-settings?debug=1`
      )
      if (data.telemetry_log_error) {
        throw new Error('所在 VM 的原生计数记录暂不可读取')
      }
      const lines = data.telemetry_log
      return Array.isArray(lines)
        ? lines.filter(
            (line): line is string => typeof line === 'string' && line !== ''
          )
        : []
    },
    refetchInterval: false,
  })
}

export function vmCredentialQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: panelQueryKeys.vmCredential(id),
    queryFn: () =>
      api<VmCredentialResponse>(
        `/api/panel/vms/${encodeURIComponent(id)}/oauth/credential`
      ),
    enabled,
    gcTime: 0,
    staleTime: 0,
  })
}

export function testModelsQueryOptions(vmId: string) {
  return queryOptions({
    queryKey: panelQueryKeys.testModels(vmId || ''),
    queryFn: () =>
      api<TestModelsPayload>(
        `/api/panel/test-models${vmId ? `?vm_id=${encodeURIComponent(vmId)}` : ''}`
      ),
    enabled: !!vmId,
  })
}

export function setupTokenSessionQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: panelQueryKeys.vmSetupTokenSession(id),
    queryFn: () =>
      api<SetupTokenSession>(
        `/api/panel/vms/${encodeURIComponent(id)}/oauth/setup-token-session`
      ),
    enabled: enabled && !!id,
    staleTime: 10_000,
    retry: false,
  })
}

export function officialCcBootstrapQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: panelQueryKeys.officialCcBootstrap(id),
    queryFn: () =>
      api<OfficialCcBootstrapPayload>(
        `/api/panel/vms/${encodeURIComponent(id)}/official-cc-bootstrap`
      ),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.status?.status === 'running' ? 2500 : false,
  })
}

export function vmOfficialCcQueryOptions(id: string) {
  return queryOptions({
    queryKey: panelQueryKeys.vmOfficialCc(id),
    queryFn: async () => {
      const response = await api<OfficialCcBootstrapPayload>(
        `/api/panel/vms/${encodeURIComponent(id)}/official-cc-bootstrap`
      )
      return response.status || null
    },
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 2500 : false,
  })
}

/**
 * Evict deleted slots before returning to a cached VM list or group picker.
 * Batch deletes pass every id at once: one eviction and one refetch, not N.
 */
export async function removeDeletedVmFromCache(
  qc: QueryClient,
  id: string | string[]
) {
  const ids = new Set(Array.isArray(id) ? id : [id])
  await qc.cancelQueries({ queryKey: panelQueryKeys.vms() })
  qc.setQueryData<Pick<VmsListResponse, 'items' | 'pool_queue'>>(
    panelQueryKeys.vms(),
    (data) =>
      data
        ? { ...data, items: (data.items || []).filter((vm) => !ids.has(vm.id)) }
        : data
  )
  for (const one of ids) qc.removeQueries({ queryKey: panelQueryKeys.vm(one) })
  void qc.invalidateQueries({ queryKey: panelQueryKeys.vms() })
  void qc.invalidateQueries({ queryKey: panelQueryKeys.groups() })
  void qc.invalidateQueries({ queryKey: panelQueryKeys.dashboard() })
}

import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import type { Diagnosis } from '@/features/vm/vm-recovery-types'

export function vmDiagnoseQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: panelQueryKeys.vmDiagnose(id),
    queryFn: () =>
      api<Diagnosis>(`/api/panel/vms/${encodeURIComponent(id)}/diagnose`),
    enabled: enabled && !!id,
  })
}

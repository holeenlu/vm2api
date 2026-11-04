import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { ModelsPayload } from '@/types/panel-models'
import type { PricingPayload } from '@/types/panel-pricing'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import type { PolicyPayload } from '@/features/models/policy'

export function modelPolicyQueryOptions(
  platform: 'anthropic' | 'openai' = 'anthropic'
) {
  return queryOptions({
    queryKey: panelQueryKeys.modelPolicy(platform),
    queryFn: () =>
      api<PolicyPayload>(`/api/panel/model-policy?platform=${platform}`),
  })
}

export function modelsQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.models(),
    queryFn: () => api<ModelsPayload>('/api/panel/models'),
  })
}

export function pricingQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.pricing(),
    queryFn: () => api<PricingPayload>('/api/panel/pricing'),
  })
}

export async function invalidatePricing(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: panelQueryKeys.pricing() }),
    qc.invalidateQueries({ queryKey: panelQueryKeys.modelPolicy() }),
  ])
}

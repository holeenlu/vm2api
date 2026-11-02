import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

/** gateway 真实模板常量（身份句、官方 agent 全文、按槽位时区渲染的 Environment），不含 billing。 */
export function personaPreviewVarsQueryOptions(timezone: string) {
  return queryOptions({
    queryKey: panelQueryKeys.personaPreviewVars(timezone),
    queryFn: () =>
      api<{ vars: Record<string, string> }>(
        `/api/panel/persona/preview-vars?timezone=${encodeURIComponent(timezone)}`
      ),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
}

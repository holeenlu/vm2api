import { useQuery } from '@tanstack/react-query'
import { usageQueryOptions } from '@/features/overview/queries'

/**
 * 使用记录明细的覆盖起点，取自已加载的用量概览（`billing.log_coverage_start`），
 * 不单独发请求；用量概览未加载（如获授权的 admin 不可见）时为 null，账本按原样显示。
 */
export function useLogCoverageStart(): string | null {
  const q = useQuery({
    ...usageQueryOptions(),
    enabled: false,
    select: (data) => data.billing?.log_coverage_start ?? null,
  })
  return q.data ?? null
}

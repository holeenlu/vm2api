import { t } from '@/i18n'
import type { ProxyQualityReport } from '@/types/proxy-quality'

/** Use report fields, never a dictionary keyed by the server's diagnostic prose. */
export function proxyQualityMessage(
  item: ProxyQualityReport['items'][number]
): string {
  if (item.target === 'base_connectivity') {
    return t(
      item.status === 'pass'
        ? 'proxies:qualityExitHealthy'
        : 'proxies:qualityExitUnavailable'
    )
  }
  if (item.status === 'challenge')
    return t('proxies:qualityCloudflareChallenge')
  if (item.status === 'pass' && item.http_status != null) {
    return t(
      item.http_status >= 200 && item.http_status < 300
        ? 'proxies:qualityHttpSuccess'
        : 'proxies:qualityHttpReachable',
      { status: item.http_status }
    )
  }
  if (item.status === 'warn' && item.http_status === 429)
    return t('proxies:qualityRateLimited')
  if (item.http_status != null)
    return t('proxies:qualityUnexpectedStatus', { status: item.http_status })
  return t('proxies:qualityConnectionFailed')
}

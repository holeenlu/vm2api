import { useMutation } from '@tanstack/react-query'
import { Activity, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { type ProbeAllResult, probeAllOutcome } from './proxy-results'
import { useRefreshProxies } from './queries'

/** 整池测通 / 测地理。天天用的两下，放在页头而不是收进设置抽屉。 */
export function ProxyBulkActions({ empty }: { empty: boolean }) {
  const { t: translate } = useTranslation('proxies')

  const refresh = useRefreshProxies()
  const probeAll = useMutation({
    mutationFn: () =>
      api<ProbeAllResult>('/api/panel/proxies/probe', { method: 'POST' }),
    onSuccess: async (data) => {
      const out = probeAllOutcome(data)
      toast[out.level](out.text)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const geoAll = useMutation({
    mutationFn: () =>
      api<{ results?: { ok?: boolean }[] }>('/api/panel/proxies/geo', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      }),
    onSuccess: async (data) => {
      const rows = data.results || []
      const ok = rows.filter((r) => r.ok).length
      toast.success(
        translate('proxies:geoCompleted', { p0: ok, p1: rows.length })
      )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <>
      <Button
        variant='outline'
        size='sm'
        onClick={() => probeAll.mutate()}
        disabled={probeAll.isPending || empty}
        loading={probeAll.isPending}
        title={translate('proxies:tcpOnlyHint')}
      >
        <Activity aria-hidden='true' />
        {translate('proxies:probeAll')}
      </Button>
      <Button
        variant='outline'
        size='sm'
        onClick={() => geoAll.mutate()}
        disabled={geoAll.isPending || empty}
        loading={geoAll.isPending}
        title={translate('proxies:geoAllHint')}
      >
        <Globe aria-hidden='true' />
        {translate('proxies:geoAll')}
      </Button>
    </>
  )
}

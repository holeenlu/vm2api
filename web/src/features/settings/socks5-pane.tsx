import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  proxiesQueryOptions,
  useRefreshProxies,
} from '@/features/proxies/queries'

export function Socks5Pane() {
  const { t } = useTranslation('settings')

  const pool = useQuery(proxiesQueryOptions())
  const refresh = useRefreshProxies()
  const ipv6 = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{
        egress?: {
          ok: boolean
          proxy_id: string
          vm_id?: string
          error?: string
        }[]
      }>('/api/panel/proxies/config', {
        method: 'PUT',
        body: JSON.stringify({ ipv6_enabled: enabled }),
      }),
    onSuccess: async (data, enabled) => {
      const failed = (data.egress || []).filter((exit) => !exit.ok)
      if (failed.length) {
        toast.warning(
          t('socks.ipv6SyncFailed', {
            value1: failed.length,
            value2: failed
              .map((exit) => exit.vm_id || exit.proxy_id)
              .join('、'),
          })
        )
      } else {
        toast.success(
          enabled ? t('socks.ipv6Enabled') : t('socks.ipv6Disabled')
        )
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const enabled = ipv6.isPending
    ? ipv6.variables
    : pool.data?.config?.ipv6_enabled === true
  return (
    <div className='space-y-3'>
      <p className='text-sm text-muted-foreground'>{t('socks.scope')}</p>
      <Card>
        <CardHeader>
          <CardTitle>{t('socks.ipv6Title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingRow label={t('socks.enableIpv6')} desc={t('socks.ipv6Help')}>
            <Switch
              checked={enabled}
              disabled={!pool.data || ipv6.isPending}
              onCheckedChange={(checked) => ipv6.mutate(checked)}
              aria-label={t('socks.enableIpv6Egress')}
            />
          </SettingRow>
          {pool.error ? (
            <p role='alert' className='text-sm text-red-3'>
              {pool.error.message}
            </p>
          ) : null}
          <p className='mt-3 text-sm text-muted-foreground'>
            <Trans
              t={t}
              i18nKey='socks.ipv6Format'
              values={{}}
              components={{ part1: <code /> }}
            />
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('socks.remote')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2 text-sm text-muted-foreground'>
          <p>{t('socks.remoteHelp')}</p>
          <p>{t('socks.keepaliveHelp')}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('socks.local')}</CardTitle>
        </CardHeader>
        <CardContent className='space-y-2 text-sm text-muted-foreground'>
          <p>{t('socks.localHelp')}</p>
          <p>{t('socks.nodeEgressHelp')}</p>
          <p>{t('socks.perHostHelp')}</p>
        </CardContent>
      </Card>
    </div>
  )
}

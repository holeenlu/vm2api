import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { directLinkText } from './model'
import { CLUSTER_NODES_KEY } from './queries'

const DEFAULT_PORT = 7790
// 只用来预填：SSH 地址本身是 IP 时直接沿用，主机名留空让人填（服务端只收 IP）。
const looksLikeIp = (s: string) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')

/** 槽位流量经 TLS 直连节点上的 kin-slot-gate，每个请求一条 TCP；不通时自动走 SSH。 */
export function DirectLinkConfig({ node }: { node: ClusterApiNode }) {
  const { t } = useTranslation('cluster')

  if (node.platform === 'darwin') {
    return (
      <section className='space-y-1 border-t pt-4'>
        <h3 className='text-sm font-medium'>{t('direct.title')}</h3>
        <p className='text-xs text-muted-foreground'>
          {t('direct.macUnsupported')}
        </p>
      </section>
    )
  }
  return <DirectLinkForm node={node} />
}

function DirectLinkForm({ node }: { node: ClusterApiNode }) {
  const { t } = useTranslation('cluster')

  const qc = useQueryClient()
  const link = node.direct_link || null
  const [address, setAddress] = useState(
    link?.address || (looksLikeIp(node.host) ? node.host : '')
  )
  const [port, setPort] = useState(link ? String(link.port) : '')
  const path = `/api/panel/cluster/nodes/${encodeURIComponent(node.id)}/direct-link`
  const done = () => qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
  const save = useMutation({
    mutationFn: () =>
      api<ClusterApiNode>(path, {
        method: 'PUT',
        body: JSON.stringify({
          address: address.trim(),
          port: port.trim() || DEFAULT_PORT,
        }),
      }),
    onSuccess: (saved) => {
      const next = saved.direct_link
      if (next?.state === 'ok') toast.success(t('direct.enabled'))
      else toast.warning(t('savedDetails', { value1: directLinkText(next) }))
      done()
    },
    onError: (err) => toast.error(err.message),
  })
  const clear = useMutation({
    mutationFn: () => api(path, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('direct.disabled'))
      setAddress('')
      setPort('')
      done()
    },
    onError: (err) => toast.error(err.message),
  })
  const busy = save.isPending || clear.isPending
  return (
    <section className='space-y-3 border-t pt-4'>
      <div className='flex items-baseline justify-between gap-2'>
        <h3 className='text-sm font-medium'>{t('direct.title')}</h3>
        <span className='text-xs text-muted-foreground'>
          {directLinkText(link)}
        </span>
      </div>
      <p className='text-xs text-muted-foreground'>{t('direct.description')}</p>
      {link?.gate_error ? (
        <p className='text-xs text-destructive'>
          {t('direct.nodeEndpoint', { value1: link.gate_error })}
        </p>
      ) : null}
      <div className='grid grid-cols-[1fr_7rem] gap-2'>
        <div className='space-y-1'>
          <Label htmlFor={`pl-addr-${node.id}`}>{t('direct.nodeIp')}</Label>
          <Input
            id={`pl-addr-${node.id}`}
            className='h-8 font-mono text-xs'
            placeholder='203.0.113.7'
            autoComplete='off'
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div className='space-y-1'>
          <Label htmlFor={`pl-port-${node.id}`}>{t('port')}</Label>
          <Input
            id={`pl-port-${node.id}`}
            className='h-8 font-mono text-xs'
            placeholder={String(DEFAULT_PORT)}
            inputMode='numeric'
            autoComplete='off'
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
      </div>
      <div className='flex gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={busy || !address.trim()}
          onClick={() => save.mutate()}
        >
          {link ? t('save') : t('enable')}
        </Button>
        {link ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => clear.mutate()}
          >
            {t('direct.disable')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}

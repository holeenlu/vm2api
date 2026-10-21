import { useEffect, useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { EMPTY_LIFETIME, expiryDate, expiryISO } from './proxy-lifetime'
import { ProxyLifetimeFields } from './proxy-lifetime-fields'
import { type ProxyEditResult, editOutcome } from './proxy-results'
import { proxyBoundIds } from './proxy-sort'

/** 与网关 PROXY_LABEL_MAX 一致。 */
const PROXY_LABEL_MAX = 64

type EditResult = ProxyEditResult & { proxy?: VmProxySnap }

/**
 * 编辑单条代理。账密**不预填** —— 后端不返回账密（只给 has_auth 布尔），
 * 所以留空的语义是「不修改」，与网关 `PUT /proxies/:id` 的按键存在性判定一致。
 */
export function ProxyEditDialog({
  proxy,
  onOpenChange,
}: {
  /** null 时关闭。传入即打开并以该条为编辑目标。 */
  proxy: VmProxySnap | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const proxies = useQuery(proxiesQueryOptions())
  const [protocol, setProtocol] = useState('socks5')
  const [lifetime, setLifetime] = useState(EMPTY_LIFETIME)
  const [enabled, setEnabled] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [clearAuth, setClearAuth] = useState(false)
  const [label, setLabel] = useState('')
  const [domainForward, setDomainForward] = useState(false)

  const boundCount = proxyBoundIds(proxy || undefined).length
  // 代理名称只影响显示：只改名称时网关不会重载已绑槽位的 worker。
  const labelChanged = label.trim() !== String(proxy?.label || '')
  const localProxy = proxy?.kind === 'local' || proxy?.scheme === 'local'

  // 按 id 重置，而不是按对象身份。代理页每次 refetch 都会产出新的 proxy 对象，
  // 若依赖对象引用，编辑期间的一次后台刷新就会把用户正在输入的账密清空。
  const proxyId = proxy?.id || ''
  useEffect(() => {
    if (!proxyId) return
    setProtocol(proxy?.scheme || 'socks5')
    setEnabled(proxy?.enabled !== false)
    setShowPassword(false)
    setLifetime({
      expires_at: expiryDate(proxy?.expires_at),
      fallback_mode: proxy?.fallback_mode || 'none',
      backup_proxy_id: proxy?.backup_proxy_id || '',
    })
    setHost(String(proxy?.host || ''))
    setPort(String(proxy?.port || ''))
    setUsername('')
    setPassword('')
    setClearAuth(false)
    setLabel(String(proxy?.label || ''))
    setDomainForward(proxy?.domain_forward === true)
    // proxy 的其余字段刻意不入依赖：只有换了目标才该重置表单。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyId])

  const save = useMutation({
    mutationFn: () => {
      // 只发真正改动的键：网关按「键是否存在」区分「不动」与「清空」，
      // 无脑全量提交会把留空的账密框当成清除指令。
      const patch: Record<string, unknown> = {}
      if (host.trim() && host.trim() !== proxy?.host) patch.host = host.trim()
      if (port.trim() && port.trim() !== String(proxy?.port ?? '')) {
        patch.port = Number(port.trim())
      }
      if (!localProxy && protocol !== (proxy?.scheme || 'socks5'))
        patch.protocol = protocol
      if (enabled !== (proxy?.enabled !== false)) patch.enabled = enabled
      if (!localProxy) {
        if (lifetime.expires_at !== expiryDate(proxy?.expires_at))
          patch.expires_at = expiryISO(lifetime.expires_at)
        if (
          lifetime.fallback_mode !== (proxy?.fallback_mode || 'none') ||
          lifetime.backup_proxy_id !== (proxy?.backup_proxy_id || '')
        ) {
          patch.fallback_mode = lifetime.fallback_mode
          patch.backup_proxy_id = lifetime.backup_proxy_id || null
        }
      }
      if (clearAuth) {
        patch.username = ''
      } else {
        if (username.trim()) patch.username = username.trim()
        if (password) patch.password = password
      }
      if (labelChanged) patch.label = label.trim()
      if (!localProxy && domainForward !== (proxy?.domain_forward === true)) {
        patch.domain_forward = domainForward
      }
      return api<EditResult>(
        `/api/panel/proxies/${encodeURIComponent(String(proxy?.id || ''))}`,
        { method: 'PUT', body: JSON.stringify(patch) }
      )
    },
    onSuccess: async (data) => {
      // 池已经改了，只是部分槽位或出口转发没跟上 —— 说清楚而不是笼统报成功。
      const out = editOutcome(data)
      toast[out.level](out.text)
      onOpenChange(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const portNum = Number(port.trim())
  // 空值也算不合法：清空输入框并不表示「删除端口」，而且清空后 patch 里既不
  // 会带 host/port 也不带账密，提交出去只会换回一个 no_editable_fields 400。
  const portBad =
    !localProxy &&
    (!port.trim() ||
      !Number.isInteger(portNum) ||
      portNum < 1 ||
      portNum > 65535)
  const hostBad = !localProxy && !host.trim()
  // 代理表单不接受「只有密码」；后端 proxyRecord() 见用户名为空就把
  // 密码一并丢掉。原本无账密的代理若只填密码，网关会以
  // password_without_username 拒掉 —— 在这里先拦住，别让用户白填一遍。
  const passwordWithoutUser =
    !clearAuth && !!password && !username.trim() && !proxy?.has_auth
  const connectionChanged =
    !localProxy &&
    !(
      protocol === (proxy?.scheme || 'socks5') &&
      host.trim() === String(proxy?.host || '') &&
      port.trim() === String(proxy?.port ?? '') &&
      !username.trim() &&
      !password &&
      !clearAuth
    )
  const domainChanged =
    !localProxy && domainForward !== (proxy?.domain_forward === true)
  const lifetimeChanged =
    !localProxy &&
    (lifetime.expires_at !== expiryDate(proxy?.expires_at) ||
      lifetime.fallback_mode !== (proxy?.fallback_mode || 'none') ||
      lifetime.backup_proxy_id !== (proxy?.backup_proxy_id || ''))
  const nothingChanged =
    !connectionChanged &&
    !labelChanged &&
    !domainChanged &&
    !lifetimeChanged &&
    enabled === (proxy?.enabled !== false)

  return (
    <Dialog open={!!proxy} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl'>
        <DialogHeader className='border-b px-6 py-5'>
          <DialogTitle>编辑代理</DialogTitle>
        </DialogHeader>
        <div className='min-h-0 space-y-5 overflow-y-auto px-6 py-5'>
          <div className='space-y-2'>
            <Label htmlFor='proxy-edit-label'>名称</Label>
            <Input
              id='proxy-edit-label'
              value={label}
              maxLength={PROXY_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='如：东京-2 号机、xx 机房'
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='proxy-edit-protocol'>协议</Label>
            <select
              id='proxy-edit-protocol'
              className='h-10 w-full rounded-md border bg-background px-3 disabled:opacity-60'
              value={localProxy ? 'local' : protocol}
              disabled={localProxy}
              onChange={(e) => setProtocol(e.target.value)}
            >
              {localProxy ? (
                <option value='local'>本地直连（LOCAL）</option>
              ) : (
                ['http', 'socks5', 'https', 'socks5h'].map((v) => (
                  <option key={v} value={v}>
                    {v.toUpperCase()}
                  </option>
                ))
              )}
            </select>
          </div>
          {localProxy ? (
            <div className='rounded-lg bg-muted/40 p-4 text-sm'>
              <p className='font-medium'>使用所在 VPS 的网络出口</p>
              <p className='mt-1 leading-6 text-muted-foreground'>
                可修改名称与启用状态。无需设置主机、端口或认证；本地直连不设有效期和到期回退。
              </p>
            </div>
          ) : (
            <>
              <div className='grid gap-4 sm:grid-cols-2'>
                <div className='space-y-1'>
                  <Label htmlFor='proxy-edit-host'>主机</Label>
                  <Input
                    id='proxy-edit-host'
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    aria-invalid={hostBad}
                  />
                </div>
                <div className='space-y-1'>
                  <Label htmlFor='proxy-edit-port'>端口</Label>
                  <Input
                    id='proxy-edit-port'
                    value={port}
                    inputMode='numeric'
                    onChange={(e) => setPort(e.target.value)}
                    aria-invalid={portBad}
                  />
                </div>
              </div>
              {hostBad ? (
                <p className='text-xs text-[color:var(--status-bad)]'>
                  主机不能为空。
                </p>
              ) : null}
              {portBad ? (
                <p className='text-xs text-[color:var(--status-bad)]'>
                  端口需在 1–65535 之间。
                </p>
              ) : null}

              <div className='space-y-1'>
                <Label htmlFor='proxy-edit-username'>用户名（可选）</Label>
                <Input
                  id='proxy-edit-username'
                  value={username}
                  autoComplete='off'
                  disabled={clearAuth}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={
                    proxy?.has_auth ? '留空则不修改' : '（当前无账密）'
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='proxy-edit-password'>密码（可选）</Label>
                <div className='relative'>
                  <Input
                    autoComplete='new-password'
                    className='pr-10'
                    type={showPassword ? 'text' : 'password'}
                    id='proxy-edit-password'
                    value={password}
                    disabled={clearAuth}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      proxy?.has_auth ? '留空则不修改' : '（当前无账密）'
                    }
                  />
                  <button
                    type='button'
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    className='absolute inset-y-0 right-3 text-muted-foreground'
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? (
                      <EyeOff className='size-4' />
                    ) : (
                      <Eye className='size-4' />
                    )}
                  </button>
                </div>
              </div>
              {proxy?.has_auth ? (
                <label className='flex items-center gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={clearAuth}
                    onChange={(e) => {
                      setClearAuth(e.target.checked)
                      // 勾上就把两个框清空：留着已输入的账密既不会提交（patch 只发
                      // username: ''），取消勾选后又会突然复活，看着像输入被吞了。
                      if (e.target.checked) {
                        setUsername('')
                        setPassword('')
                      }
                    }}
                  />
                  清除账密（改为免认证）
                </label>
              ) : null}

              <p className='text-xs text-muted-foreground'>
                账密不会回显。留空表示保持原值。
              </p>
            </>
          )}
          {localProxy ? null : (
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='checkbox'
                checked={domainForward}
                onChange={(e) => setDomainForward(e.target.checked)}
              />
              域名转发（IPv6-only 出口按主机名 CONNECT，不回落 IPv4）
            </label>
          )}
          <div className='space-y-2'>
            <Label htmlFor='proxy-edit-enabled'>状态</Label>
            <select
              id='proxy-edit-enabled'
              className='h-10 w-full rounded-md border bg-background px-3'
              value={enabled ? 'active' : 'inactive'}
              onChange={(e) => setEnabled(e.target.value === 'active')}
            >
              <option value='active'>启用</option>
              <option value='inactive'>停用</option>
            </select>
          </div>
          {!localProxy && (
            <ProxyLifetimeFields
              currentId={proxyId}
              value={lifetime}
              onChange={setLifetime}
              proxies={proxies.data?.proxies || []}
            />
          )}
          {passwordWithoutUser ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              认证需要同时提供用户名。
            </p>
          ) : null}
          {boundCount && connectionChanged ? (
            <p className='text-xs text-[color:var(--status-caution)]'>
              该代理已绑 {boundCount} 台槽位，保存后会重载它们的 worker。
            </p>
          ) : null}
        </div>
        <DialogFooter className='border-t px-6 py-4'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              hostBad ||
              portBad ||
              nothingChanged ||
              passwordWithoutUser ||
              (lifetime.fallback_mode === 'proxy' && !lifetime.backup_proxy_id)
            }
            loading={save.isPending}
          >
            更新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { House, Import, List, Plus, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/form-field'
import { EMPTY_LIFETIME, expiryISO } from './proxy-lifetime'
import { ProxyLifetimeFields } from './proxy-lifetime-fields'
import { useRefreshProxies } from './queries'

type ImportResult = {
  added?: number
  skipped?: number
  skip_details?: { line?: string; reason?: string }[]
}

type ImportOutcome = {
  added: number
  duplicates: string[]
  parseFailed: number
  /** skip_details 只回前 20 条，多出来的只知道数量。 */
  unlisted: number
}

function outcomeOf(data: ImportResult): ImportOutcome {
  const details = data.skip_details || []
  return {
    added: Number(data.added ?? 0),
    // duplicate 的 line 由网关拼成 host:port，不含账密，可以展示。
    duplicates: details
      .filter((d) => d.reason === 'duplicate' && d.line)
      .map((d) => String(d.line)),
    // parse_failed 的 line 是原始输入，可能带账密 —— 只报数量，不回显。
    parseFailed: details.filter((d) => d.reason === 'parse_failed').length,
    unlisted: Math.max(0, Number(data.skipped ?? 0) - details.length),
  }
}

/** 与网关 importLines() 的跳过规则一致：空行与 `#` 注释行不算。 */
function countLines(raw: string): number {
  return raw.split(/\r?\n/).filter((l) => {
    const t = l.trim()
    return t && !t.startsWith('#')
  }).length
}

export function ProxyImportPanel({
  hasLocal,
  onClose,
  proxies,
}: {
  hasLocal: boolean
  onClose: () => void
  proxies: VmProxySnap[]
}) {
  const refresh = useRefreshProxies()
  const [lifetime, setLifetime] = useState(EMPTY_LIFETIME)
  const [mode, setMode] = useState<'standard' | 'batch'>('standard')
  const [raw, setRaw] = useState('')
  const [form, setForm] = useState({
    label: '',
    protocol: 'http',
    host: '',
    port: '8080',
    username: '',
    password: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const lines = countLines(raw)
  const importPx = useMutation({
    mutationFn: () =>
      api<ImportResult>('/api/panel/proxies/import', {
        method: 'POST',
        body: JSON.stringify({
          ...(mode === 'batch'
            ? { text: raw }
            : { ...form, port: Number(form.port) }),
          ...lifetime,
          expires_at: expiryISO(lifetime.expires_at),
        }),
      }),
    onSuccess: async (data) => {
      const next = outcomeOf(data)
      setOutcome(next)
      if (next.added) {
        toast.success(
          `已${mode === 'batch' ? '导入' : '创建'} ${next.added} 个代理`
        )
        if (next.parseFailed === 0 && next.unlisted === 0) {
          setRaw('')
          onClose()
        }
      } else
        toast.warning(
          next.parseFailed
            ? '代理地址无法解析，请检查协议、主机和端口'
            : '代理已存在，没有新增'
        )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const addLocal = useMutation({
    mutationFn: () =>
      api<{ created?: boolean }>('/api/panel/proxies/local', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      toast.success(data.created ? '已添加本地代理' : '本地代理已存在')
      await refresh()
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <>
      <div role='tablist' aria-label='添加方式' className='flex gap-2 border-b'>
        {[
          { value: 'standard', label: '标准添加', icon: Plus },
          { value: 'batch', label: '快捷添加', icon: List },
        ].map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type='button'
            role='tab'
            aria-selected={mode === value}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm ${mode === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}
            onClick={() => {
              setMode(value as typeof mode)
              setOutcome(null)
            }}
          >
            <Icon className='size-4' />
            {label}
          </button>
        ))}
      </div>
      <form
        className='space-y-5'
        onSubmit={(e) => {
          e.preventDefault()
          if (!importPx.isPending) importPx.mutate()
        }}
      >
        {mode === 'standard' ? (
          <>
            <FormField>
              名称
              <Input
                value={form.label}
                maxLength={64}
                placeholder='请输入代理名称'
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </FormField>
            <FormField>
              协议
              <select
                className='h-10 w-full rounded-md border bg-background px-3'
                value={form.protocol}
                onChange={(e) =>
                  setForm({
                    ...form,
                    protocol: e.target.value,
                    port:
                      e.target.value === 'https'
                        ? '443'
                        : e.target.value === 'http'
                          ? '8080'
                          : '1080',
                  })
                }
              >
                {['http', 'socks5', 'https', 'socks5h'].map((v) => (
                  <option key={v} value={v}>
                    {v.toUpperCase()}
                  </option>
                ))}
              </select>
            </FormField>
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormField>
                主机
                <Input
                  value={form.host}
                  required
                  placeholder='请输入主机地址'
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </FormField>
              <FormField>
                端口
                <Input
                  type='number'
                  min={1}
                  max={65535}
                  required
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </FormField>
            </div>
            <FormField>
              用户名（可选）
              <Input
                autoComplete='off'
                value={form.username}
                placeholder='可选认证信息'
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </FormField>
            <FormField>
              密码（可选）
              <div className='relative'>
                <Input
                  autoComplete='new-password'
                  className='pr-10'
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  placeholder='可选认证信息'
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
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
            </FormField>
            <p className='text-xs leading-5 text-muted-foreground'>
              HTTP / HTTPS 使用 CONNECT 隧道；HTTPS 会验证代理证书。SOCKS5
              由本机解析域名，SOCKS5H 由代理解析域名。
            </p>
          </>
        ) : (
          <>
            <FormField>
              代理列表
              <Textarea
                value={raw}
                rows={9}
                spellCheck={false}
                autoComplete='off'
                placeholder={
                  '每行输入一个代理，例如：\nhttp://proxy.example.com:8080\nhttps://user:pass@proxy.example.com:443\nsocks5://user:pass@192.0.2.1:1080\nsocks5h://user:pass@proxy.example.com:1080'
                }
                onChange={(e) => {
                  setRaw(e.target.value)
                  setOutcome(null)
                }}
                className='min-h-60 font-mono text-sm'
              />
            </FormField>
            <p className='text-xs leading-5 text-muted-foreground'>
              支持 HTTP、HTTPS、SOCKS5、SOCKS5H。无协议的 host:port 或
              host:port:user:pass 按 SOCKS5 导入；相同协议、地址和认证自动去重。
            </p>
          </>
        )}
        <ProxyLifetimeFields
          value={lifetime}
          onChange={setLifetime}
          proxies={proxies}
        />
        {outcome && <ImportSummary outcome={outcome} />}
        <DialogFooter className='border-t pt-4'>
          <Button type='button' variant='outline' onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              importPx.isPending ||
              (mode === 'batch' ? !lines : !!form.password && !form.username)
            }
            loading={importPx.isPending}
          >
            {mode === 'batch' ? (
              <>
                <Import className='size-4' />
                导入 {lines} 个代理
              </>
            ) : (
              '创建'
            )}
          </Button>
        </DialogFooter>
      </form>
      {!hasLocal && (
        <Button
          variant='ghost'
          className='justify-start text-muted-foreground'
          onClick={() => addLocal.mutate()}
          loading={addLocal.isPending}
        >
          <House className='size-4' />
          添加本地直连出口
        </Button>
      )}
    </>
  )
}

function ImportSummary({ outcome }: { outcome: ImportOutcome }) {
  const { added, duplicates, parseFailed, unlisted } = outcome
  return (
    <div
      role='status'
      className='mt-3 space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs'
    >
      <div className='flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums'>
        <span>
          新增 <b className='font-semibold'>{added}</b>
        </span>
        {duplicates.length ? <span>重复 {duplicates.length}</span> : null}
        {parseFailed ? (
          <span className='text-[color:var(--status-bad)]'>
            无法解析 {parseFailed}
          </span>
        ) : null}
        {unlisted ? (
          <span className='text-muted-foreground'>另跳过 {unlisted}</span>
        ) : null}
      </div>
      {duplicates.length ? (
        <p className='field-host truncate text-[11px] text-muted-foreground'>
          {duplicates.join('  ')}
        </p>
      ) : null}
    </div>
  )
}

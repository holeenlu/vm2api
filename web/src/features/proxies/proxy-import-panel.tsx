import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { House, Import, List, Plus, Eye, EyeOff } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
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
  const { t: translate } = useTranslation('proxies')

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
          mode === 'batch'
            ? translate('proxies:proxiesImported', { count: next.added })
            : translate('proxies:proxiesCreated', { count: next.added })
        )
        if (next.parseFailed === 0 && next.unlisted === 0) {
          setRaw('')
          onClose()
        }
      } else
        toast.warning(
          next.parseFailed
            ? translate('proxies:parseProxyFailed')
            : translate('proxies:duplicateProxy')
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
      toast.success(
        data.created
          ? translate('proxies:localProxyAdded')
          : translate('proxies:localProxyExists')
      )
      await refresh()
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <>
      <div
        role='tablist'
        aria-label={translate('proxies:addMethod')}
        className='flex gap-2 border-b'
      >
        {[
          {
            value: 'standard',
            label: translate('proxies:standardAdd'),
            icon: Plus,
          },
          { value: 'batch', label: translate('proxies:quickAdd'), icon: List },
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
              {translate('proxies:name')}
              <Input
                value={form.label}
                maxLength={64}
                placeholder={translate('proxies:proxyNamePlaceholder')}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </FormField>
            <FormField>
              {translate('proxies:protocol')}
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
                {translate('proxies:host')}
                <Input
                  value={form.host}
                  required
                  placeholder={translate('proxies:hostPlaceholder')}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </FormField>
              <FormField>
                {translate('proxies:port')}
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
              {translate('proxies:optionalUsername')}
              <Input
                autoComplete='off'
                value={form.username}
                placeholder={translate('proxies:optionalCredentials')}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </FormField>
            <FormField>
              {translate('proxies:optionalPassword')}
              <div className='relative'>
                <Input
                  autoComplete='new-password'
                  className='pr-10'
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  placeholder={translate('proxies:optionalCredentials')}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.value })
                  }
                />
                <button
                  type='button'
                  aria-label={
                    showPassword
                      ? translate('proxies:hidePassword')
                      : translate('proxies:showPassword')
                  }
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
              {translate('proxies:protocolHint')}
            </p>
          </>
        ) : (
          <>
            <FormField>
              {translate('proxies:proxyList')}
              <Textarea
                value={raw}
                rows={9}
                spellCheck={false}
                autoComplete='off'
                placeholder={translate('proxies:importPlaceholder')}
                onChange={(e) => {
                  setRaw(e.target.value)
                  setOutcome(null)
                }}
                className='min-h-60 font-mono text-sm'
              />
            </FormField>
            <p className='text-xs leading-5 text-muted-foreground'>
              {translate('proxies:importHint')}
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
            {translate('proxies:cancel')}
          </Button>
          <Button
            disabled={
              importPx.isPending ||
              (mode === 'batch' ? !lines : !!form.password && !form.username)
            }
            loading={importPx.isPending}
          >
            <Import className='size-4' />
            {translate('proxies:importProxyCount', { count: lines })}
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
          {translate('proxies:addLocalExit')}
        </Button>
      )}
    </>
  )
}

function ImportSummary({ outcome }: { outcome: ImportOutcome }) {
  const { t: translate } = useTranslation('proxies')

  const { added, duplicates, parseFailed, unlisted } = outcome
  return (
    <div
      role='status'
      className='mt-3 space-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs'
    >
      <div className='flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums'>
        <span>
          <Trans
            ns='proxies'
            i18nKey='addedCount'
            values={{ count: added }}
            components={{ strong: <b className='font-semibold' /> }}
          />
        </span>
        {duplicates.length ? (
          <span>
            {translate('proxies:duplicateCount', { count: duplicates.length })}
          </span>
        ) : null}
        {parseFailed ? (
          <span className='text-[color:var(--status-bad)]'>
            {translate('proxies:parseFailureCount', { count: parseFailed })}
          </span>
        ) : null}
        {unlisted ? (
          <span className='text-muted-foreground'>
            {translate('proxies:alsoSkippedCount', { count: unlisted })}
          </span>
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

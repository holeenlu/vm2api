import type { VmProxySnap } from '@/types/panel-vm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'
import { SearchSelect } from '@/components/search-select'
import { type ProxyLifetime, expiryDate } from './proxy-lifetime'

export function ProxyLifetimeFields({
  value,
  onChange,
  proxies,
  currentId,
}: {
  value: ProxyLifetime
  onChange: (v: ProxyLifetime) => void
  proxies: VmProxySnap[]
  currentId?: string
}) {
  const remainingDays = value.expires_at
    ? Math.round(
        (new Date(`${value.expires_at}T12:00:00`).getTime() -
          new Date(
            `${expiryDate(new Date().toISOString())}T12:00:00`
          ).getTime()) /
          86400000
      )
    : ''
  const setDays = (days: number) => {
    if (!Number.isInteger(days) || days < 0 || days > 36500) return
    const d = new Date()
    d.setDate(d.getDate() + days)
    onChange({
      ...value,
      expires_at: days > 0 ? expiryDate(d.toISOString()) : '',
    })
  }
  return (
    <section className='space-y-5 border-t pt-5'>
      <div className='space-y-3'>
        <span className='text-sm font-medium'>有效期</span>
        <div className='flex flex-wrap gap-2'>
          {[7, 30, 90, 180].map((d) => (
            <Button
              type='button'
              key={d}
              size='sm'
              variant='outline'
              onClick={() => setDays(d)}
            >
              {d} 天
            </Button>
          ))}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => setDays(0)}
          >
            永不过期
          </Button>
        </div>
        <Input
          aria-label='自定义有效天数'
          type='number'
          min={1}
          max={36500}
          value={remainingDays}
          placeholder='自定义天数，留空为永不过期'
          onChange={(e) => setDays(Number(e.target.value))}
        />
        <FormField>
          到期日期
          <Input
            type='date'
            max='9999-12-31'
            value={value.expires_at}
            onChange={(e) => onChange({ ...value, expires_at: e.target.value })}
          />
        </FormField>
        <p className='text-xs text-muted-foreground'>
          到期日按浏览器本地时区的当天结束时间计算；留空表示永不过期。
        </p>
      </div>
      <FormField>
        到期回退
        <select
          className='h-10 w-full rounded-md border bg-background px-3'
          value={value.fallback_mode}
          onChange={(e) =>
            onChange({
              ...value,
              fallback_mode: e.target.value as ProxyLifetime['fallback_mode'],
              backup_proxy_id: '',
            })
          }
        >
          <option value='none'>不回退（暂停关联 VM 调度）</option>
          <option value='proxy'>切换备用代理</option>
          <option value='direct'>切换所在服务器本地直连</option>
        </select>
      </FormField>
      {value.fallback_mode === 'proxy' && (
        <FormField>
          备用代理
          <SearchSelect
            label='备用代理'
            value={value.backup_proxy_id}
            options={proxies
              .filter((p) => p.id !== currentId && p.kind !== 'local')
              .map((p) => ({
                id: p.id || '',
                name: `${p.label || p.host} · ${(p.scheme || 'socks5').toUpperCase()} · ${p.enabled === false || p.blocked_reason ? '不可用' : '可用'}`,
              }))}
            searchPlaceholder='搜索备用代理…'
            onChange={(id) => onChange({ ...value, backup_proxy_id: id || '' })}
          />
        </FormField>
      )}
      {value.fallback_mode !== 'none' && (
        <p className='text-xs leading-5 text-muted-foreground'>
          到期后自动切换已绑定
          VM。目标不可用或容量不足时保持暂停；续期后不会自动改回原代理。
        </p>
      )}
    </section>
  )
}

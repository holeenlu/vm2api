import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { listModelEntries } from '@/features/models/policy'
import { modelPolicyQueryOptions } from '@/features/models/queries'

export function ModelWhitelist({
  value,
  onChange,
  platform,
  enabled,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  platform: string
  enabled: boolean
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const claude = useQuery({ ...modelPolicyQueryOptions('anthropic'), enabled })
  const gpt = useQuery({ ...modelPolicyQueryOptions('openai'), enabled })
  const models = [
    ...(platform !== 'openai'
      ? listModelEntries(claude.data?.policy || {})
      : []),
    ...(platform === 'mixed' || platform === 'openai'
      ? listModelEntries(gpt.data?.policy || {})
      : []),
  ]
  const selected = new Set(value)
  const catalogIds = new Set(models.map((m) => m.id))
  // Keep existing selections removable after a platform or catalog change.
  models.push(
    ...value.filter((model) => !catalogIds.has(model)).map((id) => ({ id }))
  )
  const filtered = models
    .filter((m) =>
      `${m.id} ${m.display_name || ''}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)))
  const toggle = (model: string) =>
    onChange(
      selected.has(model) ? value.filter((v) => v !== model) : [...value, model]
    )
  return (
    <div className='space-y-2'>
      <div id={id} className='text-sm font-medium'>
        模型白名单
      </div>
      <div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant='outline'
              role='combobox'
              aria-expanded={open}
              aria-labelledby={id}
              className='w-full justify-between'
            >
              {value.length
                ? `已选 ${value.length} 个模型`
                : '选择模型（留空不额外限制）'}
              <ChevronDown className='size-4' />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align='start'
            className='w-[var(--radix-popover-trigger-width)] p-2'
          >
            <Input
              autoFocus
              aria-label='搜索模型'
              placeholder='搜索模型名称或 ID…'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div
              className='mt-2 max-h-64 overflow-auto'
              role='listbox'
              aria-label='模型列表'
              aria-multiselectable='true'
            >
              {filtered.map((m) => (
                <button
                  type='button'
                  key={m.id}
                  role='option'
                  aria-selected={selected.has(m.id)}
                  disabled={m.enabled === false && !selected.has(m.id)}
                  className='flex w-full items-center gap-2 rounded p-2 text-left text-sm hover:bg-accent disabled:opacity-50'
                  onClick={() => toggle(m.id)}
                >
                  <span className='flex size-4 shrink-0 items-center justify-center rounded border'>
                    {selected.has(m.id) && <Check className='size-3' />}
                  </span>
                  <span className='min-w-0 break-all'>
                    {m.id}
                    {!catalogIds.has(m.id)
                      ? ' · 不在当前平台目录'
                      : m.enabled === false
                        ? ' · 已停用'
                        : ''}
                  </span>
                </button>
              ))}
              {!filtered.length && (
                <p className='p-3 text-sm text-muted-foreground'>
                  {claude.isLoading || gpt.isLoading
                    ? '正在加载模型…'
                    : '没有匹配的模型'}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {(claude.error || gpt.error) && (
          <p role='alert' className='mt-2 text-sm text-destructive'>
            模型目录加载失败，请稍后重试。
          </p>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        来源为「模型」页面，按平台筛选。勾选项即为白名单，已选模型置顶；留空时允许分组资源支持的全部模型。
      </p>
    </div>
  )
}

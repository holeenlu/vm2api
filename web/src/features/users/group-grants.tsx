import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/form-field'
import type { CommercialGroup } from '@/features/groups/queries'

export type GroupGrant = {
  group_id: number
  rate_multiplier: number | null
  rpm_override?: number | null
}

export function GroupGrants({
  groups,
  value,
  onChange,
}: {
  groups: CommercialGroup[]
  value: GroupGrant[]
  onChange: (value: GroupGrant[]) => void
}) {
  const [search, setSearch] = useState('')
  return (
    <section className='space-y-3 rounded-lg border p-4' aria-label='分组授权'>
      <div>
        <h3 className='text-sm font-semibold'>分组授权</h3>
        <p className='mt-1 text-xs leading-5 text-muted-foreground'>
          勾选用户可以使用的分组。专属倍率覆盖分组默认倍率，留空则跟随默认值；0
          表示免费。专属 RPM 留空继承分组，0 = 不限制该层；用户总 RPM 仍生效。
        </p>
      </div>
      <Input
        aria-label='搜索授权分组'
        placeholder='搜索分组…'
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className='max-h-72 space-y-2 overflow-auto'>
        {groups
          .filter((g) => g.name.toLowerCase().includes(search.toLowerCase()))
          .map((g) => {
            const grant = value.find((v) => v.group_id === g.id)
            return (
              <div
                key={g.id}
                className={`grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] ${grant ? 'border-primary/40 bg-primary/5' : ''}`}
              >
                <label className='flex min-w-0 cursor-pointer items-center gap-3'>
                  <input
                    type='checkbox'
                    aria-label={`授权 ${g.name}`}
                    checked={!!grant}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [
                              ...value,
                              { group_id: g.id, rate_multiplier: null },
                            ]
                          : value.filter((v) => v.group_id !== g.id)
                      )
                    }
                  />
                  <span className='min-w-0'>
                    <span className='block text-sm font-medium break-words'>
                      {g.name}
                    </span>
                    <span className='text-xs text-muted-foreground'>
                      {g.is_exclusive ? '专属' : '公开'} · 默认{' '}
                      {g.rate_multiplier ?? 1}×
                      {g.status !== 'active' ? ' · 已停用' : ''}
                    </span>
                  </span>
                </label>
                <FormField className='text-xs'>
                  专属倍率
                  <Input
                    aria-label={`${g.name} 专属倍率`}
                    type='number'
                    min='0'
                    max='1000'
                    step='0.01'
                    disabled={!grant}
                    placeholder={String(g.rate_multiplier ?? 1)}
                    value={grant?.rate_multiplier ?? ''}
                    onChange={(e) =>
                      onChange(
                        value.map((v) =>
                          v.group_id === g.id
                            ? {
                                ...v,
                                rate_multiplier:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              }
                            : v
                        )
                      )
                    }
                  />
                </FormField>
                <FormField className='text-xs'>
                  专属 RPM
                  <Input
                    aria-label={`${g.name} 专属 RPM`}
                    type='number'
                    min='0'
                    max='1000000'
                    step='1'
                    disabled={!grant}
                    placeholder={String(g.rpm_limit || 0)}
                    value={grant?.rpm_override ?? ''}
                    onChange={(e) =>
                      onChange(
                        value.map((v) =>
                          v.group_id === g.id
                            ? {
                                ...v,
                                rpm_override:
                                  e.target.value === ''
                                    ? null
                                    : Number(e.target.value),
                              }
                            : v
                        )
                      )
                    }
                  />
                </FormField>
              </div>
            )
          })}
        {!groups.length && (
          <p className='p-3 text-sm text-muted-foreground'>
            暂无分组，请先在分组页面创建。
          </p>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        已选 {value.length}{' '}
        个分组。未选择时，用户没有分组调用资格；有效套餐仍按套餐权益授权。
      </p>
    </section>
  )
}

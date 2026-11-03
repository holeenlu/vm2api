import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TestModelsPayload } from '@/types/panel-vm'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { testModelsQueryOptions } from '@/features/vm/queries'
import type { ModelAccess } from './accounts-model'

const MODES = ['all', 'allowlist', 'denylist'] as const

/** CPR 账号「模型范围」：全部 / 白名单 / 黑名单，精确模型 ID，最多 256 个。 */
export function ModelAccessField({
  value,
  onChange,
}: {
  value: ModelAccess
  onChange: (next: ModelAccess) => void
}) {
  const { t } = useTranslation('common')
  const [search, setSearch] = useState('')
  const catalog = useQuery({
    queryKey: [...testModelsQueryOptions('').queryKey, 'openai'],
    queryFn: () =>
      api<TestModelsPayload>('/api/panel/test-models?platform=openai'),
    enabled: value.mode !== 'all',
  })
  const ids = [
    ...new Set([
      ...value.models,
      ...(catalog.data?.items || catalog.data?.models || []).map((m) => m.id),
    ]),
  ]
  const query = search.trim()
  const shown = ids.filter((id) =>
    id.toLowerCase().includes(query.toLowerCase())
  )
  const toggle = (id: string) =>
    onChange({
      ...value,
      models: value.models.includes(id)
        ? value.models.filter((m) => m !== id)
        : [...value.models, id],
    })
  return (
    <div className='grid gap-2 text-sm font-medium'>
      <p>{t('codexModelAccess')}</p>
      <div
        role='radiogroup'
        aria-label={t('codexModelAccess')}
        className='inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5'
      >
        {MODES.map((mode) => (
          <button
            key={mode}
            type='button'
            role='radio'
            aria-checked={value.mode === mode}
            className={cn(
              'h-7 rounded-md px-3 text-xs font-medium text-muted-foreground',
              value.mode === mode &&
                'bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/12%),0_0_0_1px_var(--border)]'
            )}
            onClick={() =>
              onChange({ mode, models: mode === 'all' ? [] : value.models })
            }
          >
            {t(`codexModelAccessModes.${mode}`)}
          </button>
        ))}
      </div>
      {value.mode === 'all' ? (
        <p className='text-xs font-normal text-muted-foreground'>
          {t('codexModelAccessAllHelp')}
        </p>
      ) : (
        <div className='space-y-2 rounded-lg border p-3 font-normal'>
          <Input
            value={search}
            placeholder={t('codexModelAccessSearch')}
            aria-label={t('codexModelAccessSearch')}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !query) return
              event.preventDefault()
              if (!query.includes('*') && !value.models.includes(query))
                onChange({ ...value, models: [...value.models, query] })
              setSearch('')
            }}
          />
          {value.models.length ? (
            <div className='flex flex-wrap gap-1'>
              {value.models.map((id) => (
                <span
                  key={id}
                  className='inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs'
                >
                  {id}
                  <button
                    type='button'
                    aria-label={t('codexModelAccessRemove', { id })}
                    onClick={() => toggle(id)}
                  >
                    <X className='size-3' />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className='grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2'>
            {shown.map((id) => (
              <label
                key={id}
                className='flex items-center gap-2 font-mono text-xs'
              >
                <input
                  type='checkbox'
                  checked={value.models.includes(id)}
                  onChange={() => toggle(id)}
                />
                {id}
              </label>
            ))}
          </div>
          <p className='text-xs text-muted-foreground'>
            {t(
              value.mode === 'allowlist'
                ? 'codexModelAccessAllowHelp'
                : 'codexModelAccessDenyHelp'
            )}
          </p>
        </div>
      )}
    </div>
  )
}

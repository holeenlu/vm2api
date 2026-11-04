import { useId, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import type { Resource } from './portal-model'

export function AccountProxyInput({
  endpoint,
  proxyId,
  proxies,
  onChange,
}: {
  endpoint: string
  proxyId: string
  proxies: Resource[]
  onChange: (value: { proxy_endpoint: string; proxy_id: string }) => void
}) {
  const { t } = useTranslation('vendor')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const label = (p: Resource) =>
    `${p.name} · ${String(p.config.endpoint || '')}`
  const selected = proxies.find((p) => p.id === proxyId)
  const value = selected ? label(selected) : endpoint
  const options = proxies.filter(
    (p) =>
      p.status === 'active' &&
      (p.config.available !== false || p.id === proxyId) &&
      (proxyId ||
        !endpoint.trim() ||
        label(p).toLowerCase().includes(endpoint.trim().toLowerCase()))
  )
  const choose = (p: Resource) => {
    onChange({ proxy_id: p.id, proxy_endpoint: '' })
    setOpen(false)
    setActive(-1)
    input.current?.focus()
  }
  return (
    <div
      className='space-y-2'
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <div className='relative'>
        <Input
          ref={input}
          role='combobox'
          aria-label={t('proxy')}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={
            open && active >= 0 && options[active]
              ? `${listId}-${active}`
              : undefined
          }
          autoComplete='off'
          spellCheck={false}
          maxLength={2000}
          className='pr-10'
          placeholder={t('proxyComboPlaceholder')}
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange({ proxy_endpoint: e.target.value, proxy_id: '' })
            setOpen(true)
            setActive(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              setActive((i) =>
                options.length
                  ? (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) %
                    options.length
                  : -1
              )
            } else if (
              e.key === 'Enter' &&
              open &&
              active >= 0 &&
              options[active]
            ) {
              e.preventDefault()
              choose(options[active])
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
        />
        <button
          type='button'
          aria-label={t('selectSavedProxy')}
          aria-expanded={open}
          aria-controls={listId}
          className='absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            input.current?.focus()
            setOpen(!open)
            setActive(-1)
          }}
        >
          <ChevronDown className='size-4' />
        </button>
        {open && (
          <div
            id={listId}
            role='listbox'
            aria-label={t('selectSavedProxy')}
            className='absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg'
          >
            {options.length ? (
              options.map((p, i) => (
                <div
                  key={p.id}
                  id={`${listId}-${i}`}
                  role='option'
                  aria-selected={p.id === proxyId}
                  className={
                    'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm ' +
                    (active === i
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent')
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(p)}
                >
                  <span className='min-w-0 flex-1 break-all'>{label(p)}</span>
                  {p.id === proxyId && <Check className='size-4 shrink-0' />}
                </div>
              ))
            ) : (
              <p className='px-3 py-2 text-xs text-muted-foreground'>
                {t('proxyComboEmpty')}
              </p>
            )}
          </div>
        )}
      </div>
      <p className='text-xs font-normal text-muted-foreground'>
        {t('inlineProxyHelp')}
      </p>
    </div>
  )
}

import { useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export type SearchOption = { id: string; name: string; disabled?: boolean }

/** Editable combobox shared by entity selectors; typing filters immediately. */
export function SearchSelect({
  value,
  options,
  onChange,
  allLabel,
  searchPlaceholder,
  emptyLabel = '没有匹配结果',
  loading,
  label,
  required,
  className,
}: {
  value: string | undefined
  options: SearchOption[]
  onChange: (value: string | undefined) => void
  allLabel?: string
  searchPlaceholder: string
  emptyLabel?: string
  loading?: boolean
  label?: string
  required?: boolean
  className?: string
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const selected = options.find((o) => o.id === value)
  const rows = [
    ...(allLabel ? [{ id: '', name: allLabel }] : []),
    ...options,
  ].filter((o) =>
    `${o.name} ${o.id}`.toLowerCase().includes(term.trim().toLowerCase())
  )
  const choose = (row: SearchOption) => {
    if (row.disabled) return
    onChange(row.id || undefined)
    setTerm('')
    setOpen(false)
  }
  return (
    <div className={className}>
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) setTerm('')
        }}
      >
        <PopoverAnchor asChild>
          <div className='relative'>
            <Input
              ref={input}
              className='pr-9'
              role='combobox'
              aria-label={label || searchPlaceholder}
              aria-expanded={open}
              aria-controls={id}
              aria-autocomplete='list'
              aria-activedescendant={
                open && rows[active] ? `${id}-${active}` : undefined
              }
              placeholder={searchPlaceholder}
              required={required}
              value={open ? term : selected?.name || value || allLabel || ''}
              onFocus={() => {
                setTerm('')
                setActive(0)
                setOpen(true)
              }}
              onClick={() => {
                if (!open) {
                  setTerm('')
                  setActive(0)
                  setOpen(true)
                }
              }}
              onChange={(e) => {
                setTerm(e.target.value)
                setActive(0)
                setOpen(true)
                if (!e.target.value) onChange(undefined)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                  setTerm('')
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setOpen(true)
                  setActive((n) =>
                    Math.max(
                      0,
                      Math.min(
                        rows.length - 1,
                        n + (e.key === 'ArrowDown' ? 1 : -1)
                      )
                    )
                  )
                }
                if (e.key === 'Enter' && open) {
                  e.preventDefault()
                  if (rows[active]) choose(rows[active])
                }
              }}
            />
            <ChevronDown
              aria-hidden='true'
              className='pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground'
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align='start'
          className='w-[var(--radix-popover-trigger-width)] min-w-64 p-1'
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (e.target === input.current) e.preventDefault()
          }}
        >
          <div
            id={id}
            role='listbox'
            aria-label={label || searchPlaceholder}
            className='max-h-64 overflow-auto'
          >
            {rows.map((row, i) => (
              <button
                key={row.id}
                id={`${id}-${i}`}
                type='button'
                role='option'
                aria-selected={row.id === (value || '')}
                disabled={row.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(row)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 ${active === i ? 'bg-accent/50' : ''}`}
              >
                <span className='min-w-0 flex-1 break-words'>{row.name}</span>
                {row.id === (value || '') && (
                  <Check className='size-4 shrink-0' />
                )}
              </button>
            ))}
            {!rows.length && (
              <p className='p-3 text-sm text-muted-foreground'>
                {loading ? '加载中…' : emptyLabel}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

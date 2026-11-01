import { useState } from 'react'
import { t } from '@/i18n'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/** Short copyable chip used on entry strips and the welcome snippets. */
export function CopyChip({
  text,
  mono = true,
  className,
}: {
  text: string
  mono?: boolean
  className?: string
}) {
  useTranslation('common')
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      title={t('common:copyValue', { value: text })}
      className={cn(
        'group inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs transition-colors duration-200 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        mono && 'font-mono',
        className
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        toast.success(t('common:copied'))
        setDone(true)
        window.setTimeout(() => setDone(false), 1200)
      }}
    >
      <span className='truncate'>{text}</span>
      {done ? (
        <Check className='size-3 shrink-0 text-primary' aria-hidden='true' />
      ) : (
        <Copy
          className='size-3 shrink-0 text-muted-foreground group-hover:text-foreground'
          aria-hidden='true'
        />
      )}
    </button>
  )
}

/** Icon-only copy control for multiline snippets. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string
  label: string
  className?: string
}) {
  useTranslation('common')
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        toast.success(t('common:copied'))
        setDone(true)
        window.setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? (
        <Check className='size-3.5 text-primary' aria-hidden='true' />
      ) : (
        <Copy className='size-3.5' aria-hidden='true' />
      )}
    </button>
  )
}

import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** A stacked label and its control, including safe wrapping on narrow dialogs. */
export function FormField({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'grid min-w-0 gap-2 text-sm leading-5 font-medium',
        className
      )}
      {...props}
    />
  )
}

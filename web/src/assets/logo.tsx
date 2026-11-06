import { type SVGProps } from 'react'
import { cn } from '@/lib/utils'
import { useBranding } from '@/context/branding-provider'

export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const brand = useBranding()
  if (brand.logo_url)
    return (
      <img
        src={brand.logo_url}
        alt={props['aria-hidden'] ? '' : brand.name}
        className={cn(
          'block size-6 max-h-full max-w-full object-contain',
          className
        )}
      />
    )
  return (
    <svg
      id='tapmodels-brand-logo'
      viewBox='0 0 64 64'
      xmlns='http://www.w3.org/2000/svg'
      className={cn('block size-6 max-h-full max-w-full', className)}
      {...props}
    >
      <title>{brand.name}</title>
      <rect x='7' y='12' width='30' height='16' rx='5' fill='#101820' />
      <rect x='40' y='12' width='17' height='16' rx='5' fill='#08b7a6' />
      <rect x='25' y='31' width='20' height='24' rx='5' fill='#101820' />
    </svg>
  )
}

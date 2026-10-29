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
        className={cn('size-6 object-contain', className)}
      />
    )
  return (
    <svg
      id='tapmodels-brand-logo'
      viewBox='0 0 48 48'
      xmlns='http://www.w3.org/2000/svg'
      fill='none'
      className={cn('size-6', className)}
      {...props}
    >
      <title>{brand.name}</title>
      <defs>
        <filter
          id='tapmodels-glow'
          x='-30%'
          y='-30%'
          width='160%'
          height='160%'
        >
          <feGaussianBlur in='SourceGraphic' stdDeviation='2' result='blur' />
          <feMerge>
            <feMergeNode in='blur' />
            <feMergeNode in='SourceGraphic' />
          </feMerge>
        </filter>
        <linearGradient id='tapmodels-cyan' x1='0%' y1='0%' x2='100%' y2='100%'>
          <stop offset='0%' stopColor='#00f0ff' />
          <stop offset='100%' stopColor='#0099ff' />
        </linearGradient>
      </defs>

      {/* Terminal Chevron > */}
      <path
        d='M12 12 L24 24 L12 36'
        stroke='currentColor'
        strokeWidth='5.5'
        strokeLinecap='round'
        strokeLinejoin='round'
      />

      {/* Neon Cyan Slash / */}
      <path
        d='M28 36 L36 12'
        stroke='url(#tapmodels-cyan)'
        strokeWidth='5.5'
        strokeLinecap='round'
        filter='url(#tapmodels-glow)'
      />
      <path
        d='M28 36 L36 12'
        stroke='#00f0ff'
        strokeWidth='4.5'
        strokeLinecap='round'
      />
    </svg>
  )
}

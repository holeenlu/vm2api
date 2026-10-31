import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { normalizeLocale } from '@/i18n'
import { Menu, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/assets/logo'
import { cn } from '@/lib/utils'
import { useBranding } from '@/context/branding-provider'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

export function AppTitle({
  versionControl,
  showDetails = true,
}: {
  versionControl?: ReactNode
  showDetails?: boolean
}) {
  const { setOpenMobile } = useSidebar()
  const brand = useBranding()
  const { t, i18n } = useTranslation('common')
  return (
    <SidebarMenu>
      <SidebarMenuItem className='rounded-xl border border-primary/25 bg-gradient-to-br from-primary/12 via-primary/[0.03] to-transparent p-2.5 group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-none group-data-[collapsible=icon]:p-0'>
        <div className='flex items-center gap-2'>
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            aria-label={brand.name}
            className='flex min-w-0 flex-1 items-center gap-2.5 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          >
            <span className='grid size-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-white shadow-md ring-1 ring-cyan-500/35 group-data-[collapsible=icon]:size-8'>
              <Logo
                aria-hidden
                className='size-5 group-data-[collapsible=icon]:size-4'
              />
            </span>
            <span className='grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='truncate text-base font-bold tracking-tight'>
                {brand.name}
              </span>
              {showDetails && (
                <span className='truncate text-xs text-sidebar-foreground/60'>
                  {brand.taglines?.[
                    normalizeLocale(i18n.resolvedLanguage || i18n.language)
                  ] ||
                    brand.tagline ||
                    t('common:console')}
                </span>
              )}
            </span>
          </Link>
          <ToggleSidebar className='group-data-[collapsible=icon]:hidden' />
        </div>
        {showDetails && (
          <div className='mt-2.5 grid gap-1.5 group-data-[collapsible=icon]:hidden'>
            {versionControl}
          </div>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  const { t } = useTranslation('common')
  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn(
        'aspect-square size-8 shrink-0 cursor-pointer max-md:scale-125',
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>{t('common:toggleSidebar')}</span>
    </Button>
  )
}

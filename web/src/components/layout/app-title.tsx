import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
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
  return (
    <SidebarMenu>
      <SidebarMenuItem className='rounded-xl border border-sidebar-border/70 bg-sidebar p-3 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0'>
        <div className='flex items-center gap-2'>
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            aria-label={brand.name}
            className='flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          >
            <span
              className={cn(
                'grid size-10 shrink-0 place-items-center overflow-hidden rounded-[10px] group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg',
                brand.logo_url
                  ? 'bg-transparent'
                  : 'bg-slate-950 text-white ring-1 ring-sidebar-border'
              )}
            >
              <Logo
                aria-hidden
                className={
                  brand.logo_url
                    ? 'size-full'
                    : 'size-6 group-data-[collapsible=icon]:size-5'
                }
              />
            </span>
            <span className='block min-w-0 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='block truncate text-[17px] font-semibold tracking-tight'>
                {brand.name}
              </span>
            </span>
          </Link>
          <ToggleSidebar className='text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden hover:text-sidebar-foreground' />
        </div>
        {showDetails && (
          <div className='mt-3 grid gap-1.5 group-data-[collapsible=icon]:hidden'>
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

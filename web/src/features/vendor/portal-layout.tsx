import type { ReactNode } from 'react'
import {
  BarChart3,
  ChevronLeft,
  FileText,
  Globe2,
  LayoutGrid,
  LogOut,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/assets/logo'
import { getCookie } from '@/lib/cookies'
import { useBranding } from '@/context/branding-provider'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@/components/ui/sidebar'
import { LanguageSelect } from '@/components/language-select'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  allowedViews,
  viewLabel,
  type Vendor,
  type ViewKey,
} from './portal-model'

const icons = {
  accounts: LayoutGrid,
  proxies: Globe2,
  vendors: Users,
  usage: BarChart3,
  billing: FileText,
}

type Props = {
  vendor: Vendor
  view: ViewKey
  onView: (view: ViewKey) => void
  onSignOut: () => void
  children: ReactNode
}

function PortalSidebar({
  vendor,
  view,
  onView,
}: Omit<Props, 'children' | 'onSignOut'>) {
  const { t } = useTranslation('vendor')
  const branding = useBranding()
  const { state, toggleSidebar, setOpenMobile } = useSidebar()
  const allowed = allowedViews(vendor)
  const groups: { label: string; keys: ViewKey[] }[] = [
    { label: t('resources'), keys: ['accounts', 'proxies', 'vendors'] },
    { label: t('statistics'), keys: ['usage', 'billing'] },
  ]
  const navigate = (next: ViewKey) => {
    onView(next)
    setOpenMobile(false)
  }

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader>
        <button
          type='button'
          onClick={() => navigate('accounts')}
          aria-label={branding.name}
          className='flex min-w-0 items-center gap-3 rounded-xl border border-sidebar-border/70 p-3 text-start outline-hidden group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:p-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring'
        >
          <span
            className={`grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg group-data-[collapsible=icon]:size-8 ${branding.logo_url ? 'bg-transparent' : 'bg-slate-950 text-white ring-1 ring-sidebar-border'}`}
          >
            <Logo
              aria-hidden
              className={branding.logo_url ? 'size-full' : 'size-6'}
            />
          </span>
          <span className='min-w-0 group-data-[collapsible=icon]:hidden'>
            <span className='block truncate text-[17px] font-semibold tracking-tight'>
              {branding.name}
            </span>
            <span className='mt-0.5 block text-xs text-muted-foreground'>
              {t('portal')}
            </span>
          </span>
        </button>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t('navLabel')}>
          {groups
            .filter((group) => group.keys.some((key) => allowed.includes(key)))
            .map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.keys
                      .filter((key) => allowed.includes(key))
                      .map((key) => {
                        const Icon = icons[key]
                        return (
                          <SidebarMenuItem key={key}>
                            <SidebarMenuButton
                              isActive={view === key}
                              aria-current={view === key ? 'page' : undefined}
                              tooltip={viewLabel(key)}
                              onClick={() => navigate(key)}
                            >
                              <Icon aria-hidden />
                              <span>{viewLabel(key)}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
        </nav>
      </SidebarContent>
      <SidebarFooter className='border-t border-sidebar-border'>
        <div className='min-w-0 px-2 py-3 text-sm md:hidden'>
          <p className='truncate font-medium' title={vendor.name}>
            {vendor.name}
          </p>
          <p className='mt-1 text-xs text-muted-foreground'>
            {vendor.tier === 1 ? t('tierOne') : t('tierTwo')}
          </p>
        </div>
        <SidebarMenu className='hidden md:block'>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              aria-label={t(
                state === 'collapsed' ? 'expandNav' : 'collapseNav'
              )}
              tooltip={t(state === 'collapsed' ? 'expandNav' : 'collapseNav')}
            >
              <ChevronLeft
                className={state === 'collapsed' ? 'rotate-180' : ''}
              />
              <span>{t('collapse')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

export function VendorPortalLayout({
  vendor,
  view,
  onView,
  onSignOut,
  children,
}: Props) {
  const { t } = useTranslation('vendor')
  return (
    <SidebarProvider defaultOpen={getCookie('sidebar_state') !== 'false'}>
      <PortalSidebar vendor={vendor} view={view} onView={onView} />
      <SidebarInset className='min-w-0'>
        <Header fixed className='border-b bg-background/95 backdrop-blur-sm'>
          <span className='min-w-0 truncate text-sm font-medium'>
            {viewLabel(view) || t('noPermissionPage')}
          </span>
          <div className='ms-auto flex shrink-0 items-center gap-1 sm:gap-2'>
            <LanguageSelect />
            <ThemeSwitch />
            <div className='ms-2 hidden max-w-52 min-w-0 border-s ps-4 text-end text-xs sm:block'>
              <p className='truncate font-medium' title={vendor.name}>
                {vendor.name}
              </p>
              <p className='mt-0.5 text-muted-foreground'>
                {vendor.tier === 1 ? t('tierOne') : t('tierTwo')}
              </p>
            </div>
            <Button
              variant='ghost'
              size='icon'
              aria-label={t('logout')}
              onClick={onSignOut}
            >
              <LogOut />
            </Button>
          </div>
        </Header>
        <Main fluid className='min-w-0 space-y-6 md:px-6'>
          {children}
        </Main>
      </SidebarInset>
    </SidebarProvider>
  )
}

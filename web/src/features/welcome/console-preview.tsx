import { Expand } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/context/theme-provider'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

function PreviewDetails({ text }: { text: string }) {
  return (
    <ol className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
      {text.split('\n').map((line, index) => (
        <li
          key={line}
          className='flex items-start gap-3 text-sm leading-relaxed text-muted-foreground'
        >
          <span className='flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-medium text-accent-foreground'>
            {index + 1}
          </span>
          {line}
        </li>
      ))}
    </ol>
  )
}

export function ConsolePreview() {
  const { t } = useTranslation('welcome')
  const { resolvedTheme } = useTheme()
  const pages = [
    {
      id: 'statistics',
      label: t('welcome:marketingConsoleDashboard'),
      description: t('welcome:marketingPreviewDashboardHelp'),
    },
    {
      id: 'usage',
      label: t('welcome:marketingConsoleUsage'),
      description: t('welcome:marketingPreviewUsageHelp'),
    },
    {
      id: 'keys',
      label: t('welcome:marketingConsoleKeys'),
      description: t('welcome:marketingPreviewKeysHelp'),
    },
  ]

  return (
    <Tabs defaultValue='statistics' className='min-w-0 gap-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <TabsList
          aria-label={t('welcome:marketingConsoleEyebrow')}
          className='h-auto max-w-full flex-wrap'
        >
          {pages.map(({ id, label }) => (
            <TabsTrigger
              key={id}
              value={id}
              className='px-3 py-2 text-xs sm:text-sm'
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Badge variant='outline'>{t('welcome:marketingPreviewSample')}</Badge>
      </div>

      {pages.map(({ id, label, description }) => {
        const src = `${import.meta.env.BASE_URL}welcome/admin-${id}-${resolvedTheme}.jpg`
        return (
          <TabsContent key={id} value={id} className='min-w-0 space-y-6'>
            <a
              href={src}
              target='_blank'
              rel='noreferrer'
              aria-label={t('welcome:marketingPreviewViewImage', {
                page: label,
              })}
              className='group block overflow-hidden rounded-xl border bg-card shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            >
              <img
                src={src}
                alt={t('welcome:marketingPreviewImageAlt', { page: label })}
                width={1440}
                height={1000}
                loading='lazy'
                className='h-auto w-full'
              />
              <span className='flex items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground transition-colors group-hover:text-foreground'>
                <Expand aria-hidden className='size-3.5' />
                {t('welcome:marketingPreviewViewImage', { page: label })}
              </span>
            </a>
            <PreviewDetails text={description} />
          </TabsContent>
        )
      })}
      <p className='text-xs leading-relaxed text-muted-foreground'>
        {t('welcome:marketingPreviewNote')}
      </p>
    </Tabs>
  )
}

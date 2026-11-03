import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function AccountPlatformChip({
  platform,
  className,
}: {
  platform?: string | null
  className?: string
}) {
  const { t } = useTranslation('vendor')
  const isOpenAI = platform === 'openai'
  const isAnthropic = platform === 'anthropic'
  if (!isOpenAI && !isAnthropic) return <span className={className}>—</span>

  const Icon = isOpenAI ? OpenAI : ClaudeColor
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] leading-none font-medium',
        isOpenAI
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
          : 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
        className
      )}
    >
      <Icon className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
      {isOpenAI ? t('wb.openai') : t('wb.anthropic')}
    </span>
  )
}

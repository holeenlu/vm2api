import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { changelogQueryOptions, type ChangelogEntry } from './queries'

export function AboutPane() {
  const { t } = useTranslation('settings')
  const changelog = useQuery(changelogQueryOptions())
  const entries =
    changelog.data?.entries?.filter(
      (entry) => entry.version !== 'unreleased'
    ) || []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('about.changelog')}</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4'>
        {changelog.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {changelog.error.message}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {t('about.noChangelog')}
          </p>
        ) : (
          entries.map((entry) => (
            <ChangelogBlock key={entry.heading} entry={entry} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function ChangelogBlock({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className='space-y-1.5 wrap-anywhere'>
      <div className='flex flex-wrap items-baseline gap-2'>
        <h3 className='font-medium'>
          {entry.tag || entry.version}
          {entry.date ? (
            <span className='ms-2 text-sm font-normal text-muted-foreground'>
              {entry.date}
            </span>
          ) : null}
        </h3>
        {entry.needs_wrap_cli_sync ? (
          <Badge variant='outline'>wrap-cli/sync</Badge>
        ) : null}
      </div>
      {entry.title ? (
        <p className='text-sm text-muted-foreground'>{entry.title}</p>
      ) : null}
      {entry.bullets.length > 0 ? (
        <ul className='list-disc space-y-1 ps-5 text-sm'>
          {entry.bullets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

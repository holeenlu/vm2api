import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelVendorIcon } from '@/components/model-vendor-icon'

// Illustrative data only. This public preview never reads account or usage APIs.
const MODELS = [
  // i18n-exempt "claude-sonnet-5-5" -- Provider model identifiers are API data.
  'claude-sonnet-5-5',
  // i18n-exempt "gpt-6.1-sol" -- Provider model identifiers are API data.
  'gpt-6.1-sol',
]
const TREND = [28, 40, 34, 52, 46, 62, 54, 72, 60, 80, 70, 90]

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
  const { t, i18n } = useTranslation('welcome')
  const number = (value: number) => value.toLocaleString(i18n.language)
  const money = (value: number) =>
    value.toLocaleString(i18n.language, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    })
  const tabs = [
    ['dashboard', t('welcome:marketingConsoleDashboard')],
    ['usage', t('welcome:marketingConsoleUsage')],
    ['keys', t('welcome:marketingConsoleKeys')],
  ]

  return (
    <Tabs defaultValue='dashboard' className='min-w-0 gap-5'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <TabsList
          aria-label={t('welcome:marketingConsoleEyebrow')}
          className='h-auto max-w-full flex-wrap'
        >
          {tabs.map(([id, label]) => (
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

      <TabsContent value='dashboard' className='min-w-0 space-y-6'>
        <Card className='gap-0 overflow-hidden py-0 shadow-xs'>
          <div className='border-b bg-muted/30 px-5 py-4 text-sm font-medium'>
            {t('welcome:marketingConsoleDashboard')}
          </div>
          <CardContent className='space-y-5 p-4 sm:p-6'>
            <dl className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
              {[
                [t('welcome:marketingPreviewRequests'), number(12480)],
                [t('welcome:marketingPreviewTokens'), number(8640000)],
                [t('welcome:marketingPreviewCost'), money(128.4)],
                [t('welcome:marketingPreviewLatency'), `${number(1.24)} s`],
              ].map(([label, value]) => (
                <div key={label} className='min-w-0 rounded-lg border p-4'>
                  <dt className='text-xs text-muted-foreground'>{label}</dt>
                  <dd className='mt-2 text-xl font-semibold tracking-tight break-all tabular-nums sm:text-2xl'>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className='grid gap-5 lg:grid-cols-[1.4fr_1fr]'>
              <div className='rounded-lg border p-4'>
                <p className='text-sm font-medium'>
                  {t('welcome:marketingPreviewTrend')}
                </p>
                <div
                  aria-hidden
                  className='mt-6 flex h-28 items-end gap-2 border-b px-1'
                >
                  {TREND.map((value, index) => (
                    <div
                      key={index}
                      className='flex-1 rounded-t-sm bg-primary/70'
                      style={{ height: `${value}%` }}
                    />
                  ))}
                </div>
                <p className='mt-3 text-xs text-muted-foreground'>
                  {t('welcome:marketingPreviewPeriod')}
                </p>
              </div>
              <div className='space-y-5 rounded-lg border p-4'>
                <p className='text-sm font-medium'>
                  {t('welcome:marketingPreviewDistribution')}
                </p>
                {MODELS.map((model, index) => (
                  <div key={model} className='space-y-2'>
                    <div className='flex min-w-0 items-center gap-2 text-xs'>
                      <ModelVendorIcon modelId={model} />
                      <span className='min-w-0 font-mono break-all'>
                        {model}
                      </span>
                      <span className='ml-auto shrink-0 tabular-nums'>
                        {index === 0 ? '64%' : '36%'}
                      </span>
                    </div>
                    <div
                      aria-hidden
                      className='h-2 overflow-hidden rounded-full bg-muted'
                    >
                      <div
                        className='h-full rounded-full bg-primary/70'
                        style={{ width: index === 0 ? '64%' : '36%' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
        <PreviewDetails text={t('welcome:marketingPreviewDashboardHelp')} />
      </TabsContent>

      <TabsContent value='usage' className='min-w-0 space-y-6'>
        <Card className='gap-0 overflow-hidden py-0 shadow-xs'>
          <div className='flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-5 py-4'>
            <p className='text-sm font-medium'>
              {t('welcome:marketingConsoleUsage')}
            </p>
            <span className='text-xs text-muted-foreground'>
              {t('welcome:marketingPreviewPeriod')}
            </span>
          </div>
          <CardContent className='min-w-0 px-3 py-2 sm:px-5'>
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    t('welcome:marketingPreviewModel'),
                    t('welcome:marketingInput'),
                    t('welcome:marketingOutput'),
                    t('welcome:marketingCacheRead'),
                    t('welcome:marketingPreviewCost'),
                    t('welcome:marketingPreviewStatus'),
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[0, 1, 2, 3].map((row) => (
                  <TableRow key={row}>
                    <TableCell className='py-5 font-mono text-xs'>
                      {MODELS[row % 2]}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {number(1280 + row * 320)}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {number(256 + row * 64)}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {number(1024 + row * 256)}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {money(0.02 + row * 0.01)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='secondary'
                        className='bg-accent font-mono text-accent-foreground'
                      >
                        {200}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <PreviewDetails text={t('welcome:marketingPreviewUsageHelp')} />
      </TabsContent>

      <TabsContent value='keys' className='min-w-0 space-y-6'>
        <Card className='gap-0 overflow-hidden py-0 shadow-xs'>
          <div className='border-b bg-muted/30 px-5 py-4 text-sm font-medium'>
            {t('welcome:marketingConsoleKeys')}
          </div>
          <CardContent className='grid gap-4 p-4 sm:grid-cols-2 sm:p-6'>
            {[0, 1].map((index) => (
              <div
                key={index}
                className='min-w-0 space-y-5 rounded-lg border p-5'
              >
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <p className='text-sm font-medium'>
                    {t('welcome:marketingPreviewProject', {
                      name: index === 0 ? 'A' : 'B',
                    })}
                  </p>
                  <Badge
                    variant='secondary'
                    className='bg-accent text-accent-foreground'
                  >
                    {t('welcome:marketingPreviewActive')}
                  </Badge>
                </div>
                <div className='rounded-md bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground'>
                  sk-••••••••••••••••
                </div>
                <dl className='grid grid-cols-2 gap-3 border-t pt-4 text-sm'>
                  <div className='space-y-1'>
                    <dt className='text-xs text-muted-foreground'>
                      {t('welcome:marketingPreviewCost')}
                    </dt>
                    <dd className='font-medium tabular-nums'>
                      {money(index === 0 ? 42.8 : 16.2)}
                    </dd>
                  </div>
                  <div className='space-y-1'>
                    <dt className='text-xs text-muted-foreground'>
                      {t('welcome:marketingRiskQuota')}
                    </dt>
                    <dd className='font-medium tabular-nums'>{money(100)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </CardContent>
        </Card>
        <PreviewDetails text={t('welcome:marketingPreviewKeysHelp')} />
      </TabsContent>
      <p className='text-xs leading-relaxed text-muted-foreground'>
        {t('welcome:marketingPreviewNote')}
      </p>
    </Tabs>
  )
}

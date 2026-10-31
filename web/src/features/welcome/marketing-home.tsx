import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  Gauge,
  KeyRound,
  LockKeyhole,
  Menu,
  Network,
  Route,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Logo } from '@/assets/logo'
import { cn } from '@/lib/utils'
import { useBranding } from '@/context/branding-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CopyButton } from '@/components/copy-chip'
import { LanguageSelect } from '@/components/language-select'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { ThemeSwitch } from '@/components/theme-switch'
import { ApiDemo } from './api-demo'
import { ConsolePreview } from './console-preview'
import { scrollToSection } from './scroll'

function SectionHeading({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow: string
  title: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn('max-w-3xl space-y-3', className)}>
      <p className='text-xs font-medium tracking-widest text-primary uppercase'>
        {eyebrow}
      </p>
      <h2 className='text-2xl leading-snug font-semibold tracking-tight text-balance text-foreground sm:text-3xl'>
        {title}
      </h2>
      {description ? (
        <p className='text-sm leading-relaxed text-muted-foreground md:text-base'>
          {description}
        </p>
      ) : null}
    </div>
  )
}

function MarketingCard({
  icon: Icon,
  title,
  description,
  featured = false,
  step,
}: {
  icon: typeof Route
  title: string
  description: string
  featured?: boolean
  step?: number
}) {
  return (
    <Card
      className={cn(
        'min-w-0 gap-0 py-0 shadow-xs',
        featured && 'border-primary/30 bg-accent/40'
      )}
    >
      <CardContent className='flex flex-col gap-3 p-6'>
        <div className='flex items-center justify-between gap-3'>
          <span className='flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground'>
            <Icon aria-hidden className='size-5' />
          </span>
          {step ? (
            <span
              aria-hidden
              className='font-mono text-sm text-muted-foreground'
            >
              0{step}
            </span>
          ) : null}
        </div>
        <h3 className='text-base font-semibold text-foreground'>{title}</h3>
        <p className='text-sm leading-relaxed whitespace-pre-line text-muted-foreground'>
          {description}
        </p>
      </CardContent>
    </Card>
  )
}

export function MarketingHome({
  signedIn,
  baseUrl,
}: {
  signedIn: boolean
  baseUrl: string
}) {
  const { t } = useTranslation('welcome')
  const brand = useBranding()
  const consoleLink = signedIn ? '/overview' : '/login'
  const consoleLabel = signedIn
    ? t('welcome:openConsole')
    : t('welcome:signInConsole')
  const featureCards = [
    {
      icon: Network,
      title: t('welcome:marketingFeatureGateway'),
      description: t('welcome:marketingFeatureGatewayHelp'),
    },
    {
      icon: Zap,
      title: t('welcome:marketingFeatureRouting'),
      description: t('welcome:marketingFeatureRoutingHelp'),
    },
    {
      icon: Users,
      title: t('welcome:marketingFeatureControl'),
      description: t('welcome:marketingFeatureControlHelp'),
    },
    {
      icon: LockKeyhole,
      title: t('welcome:marketingFeaturePrivacy'),
      description: t('welcome:marketingFeaturePrivacyHelp'),
    },
  ]
  const models = [
    // i18n-exempt "claude-fable-5-1" -- Provider model identifiers are API data.
    ['claude-fable-5-1', 'Claude', '$10.00', '$50.00', '$0.25'],
    // i18n-exempt "claude-opus-5-5" -- Provider model identifiers are API data.
    ['claude-opus-5-5', 'Claude', '$4.00', '$20.00', '$0.20'],
    // i18n-exempt "claude-sonnet-5-5" -- Provider model identifiers are API data.
    ['claude-sonnet-5-5', 'Claude', '$2.00', '$10.00', '$0.20'],
    // i18n-exempt "gpt-6-astra" -- Provider model identifiers are API data.
    ['gpt-6-astra', 'OpenAI', '$10.00', '$50.00', '$1.00'],
    // i18n-exempt "gpt-6.1-sol" -- Provider model identifiers are API data.
    ['gpt-6.1-sol', 'OpenAI', '$2.00', '$10.00', '$0.10'],
    // i18n-exempt "gpt-6-luna" -- Provider model identifiers are API data.
    ['gpt-6-luna', 'OpenAI', '$0.10', '$0.50', '$0.01'],
  ]
  const securityItems = [
    [
      t('welcome:marketingSecurityRetention'),
      t('welcome:marketingSecurityRetentionHelp'),
    ],
    [
      t('welcome:marketingSecurityTraining'),
      t('welcome:marketingSecurityTrainingHelp'),
    ],
    [
      t('welcome:marketingSecurityTransfer'),
      t('welcome:marketingSecurityTransferHelp'),
    ],
  ]

  const sections = [
    ...(signedIn ? [['welcome-setup', t('welcome:checklist')]] : []),
    ['welcome-models', t('welcome:marketingNavModels')],
    ['welcome-how', t('welcome:marketingNavHow')],
    ['welcome-security', t('welcome:marketingNavSecurity')],
    ['welcome-agents', t('welcome:marketingNavAgents')],
  ]

  return (
    <div className='relative bg-background text-foreground'>
      <header className='fixed inset-x-0 top-0 z-40 border-b bg-background/95 backdrop-blur-sm'>
        <div className='mx-auto max-w-6xl px-4 sm:px-6 lg:px-8'>
          <nav
            aria-label={t('welcome:navigation')}
            className='flex h-16 items-center justify-between gap-3'
          >
            <button
              type='button'
              onClick={() => scrollToSection('welcome-top')}
              aria-label={brand.name}
              className='flex min-w-0 shrink-0 items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            >
              <Logo aria-hidden className='size-9 shrink-0' />
              <span className='hidden max-w-32 truncate text-base font-semibold tracking-tight sm:inline'>
                {brand.name}
              </span>
            </button>
            <div className='hidden items-center gap-1 xl:flex'>
              {sections.map(([id, label]) => (
                <Button
                  key={id}
                  variant='ghost'
                  size='sm'
                  onClick={() => scrollToSection(id)}
                  className='text-muted-foreground'
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className='flex shrink-0 items-center gap-0.5'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant='ghost'
                    size='icon'
                    className='xl:hidden'
                    aria-label={t('welcome:navigation')}
                  >
                    <Menu aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end'>
                  {sections.map(([id, label]) => (
                    <DropdownMenuItem
                      key={id}
                      onSelect={() => scrollToSection(id)}
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <LanguageSelect />
              <ThemeSwitch />
              <Button asChild size='sm'>
                <Link to={consoleLink} aria-label={consoleLabel}>
                  <span className='hidden sm:inline'>{consoleLabel}</span>
                  <span className='sm:hidden'>
                    {t('welcome:marketingConsoleEntry')}
                  </span>
                  <ArrowRight
                    aria-hidden
                    className='hidden size-3.5 sm:block'
                  />
                </Link>
              </Button>
            </div>
          </nav>
        </div>
      </header>

      <div className='relative'>
        <section
          id='welcome-top'
          className='mx-auto grid max-w-6xl items-center gap-10 px-4 pt-28 pb-12 sm:px-6 sm:pb-16 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:pt-32 lg:pb-20'
        >
          <div className='min-w-0 space-y-6'>
            <Badge
              variant='outline'
              className='border-primary/20 bg-accent px-3 py-1 text-accent-foreground'
            >
              {t('welcome:marketingHeroBadge')}
            </Badge>
            <h1 className='text-3xl leading-tight font-semibold tracking-tight text-balance whitespace-pre-line text-foreground sm:text-4xl lg:text-5xl'>
              {t('welcome:marketingHeroTitle')}
            </h1>
            <p className='max-w-xl text-base leading-7 text-pretty text-muted-foreground'>
              {t('welcome:marketingHeroDescription')}
            </p>
            <div className='flex flex-wrap gap-3'>
              <Button asChild size='lg'>
                <Link to={consoleLink}>
                  {consoleLabel}
                  <ArrowRight aria-hidden className='size-4' />
                </Link>
              </Button>
              <Button
                variant='outline'
                size='lg'
                onClick={() => scrollToSection('welcome-agents')}
              >
                {t('welcome:marketingHeroSecondary')}
              </Button>
            </div>
            <ul className='grid gap-2.5 text-sm text-muted-foreground'>
              {[
                'marketingHeroPointOne',
                'marketingHeroPointTwo',
                'marketingHeroPointThree',
              ].map((key) => (
                <li key={key} className='flex items-start gap-2'>
                  <Check
                    aria-hidden
                    className='mt-0.5 size-4 shrink-0 text-primary'
                  />
                  {t(`welcome:${key}`)}
                </li>
              ))}
            </ul>
          </div>
          <div className='min-w-0'>
            <ApiDemo baseUrl={baseUrl} />
          </div>
        </section>

        <section className='border-y bg-muted/30'>
          <div className='mx-auto grid max-w-6xl grid-cols-2 gap-x-6 gap-y-8 px-4 py-8 sm:px-6 md:grid-cols-4 lg:px-8'>
            {[
              [t('welcome:marketingStatProtocols'), '3'],
              [t('welcome:marketingStatProviders'), '2+'],
              [
                t('welcome:marketingStatRouting'),
                t('welcome:marketingStatRoutingValue'),
              ],
              [
                t('welcome:marketingStatLogs'),
                t('welcome:marketingStatLogsValue'),
              ],
            ].map(([label, value]) => (
              <div key={label} className='text-center'>
                <div className='text-xl font-semibold tracking-tight text-foreground tabular-nums sm:text-2xl'>
                  {value}
                </div>
                <div className='mt-1.5 text-xs text-muted-foreground sm:text-sm'>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className='mx-auto max-w-6xl scroll-mt-20 space-y-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'>
          <SectionHeading
            eyebrow={t('welcome:marketingWhyEyebrow')}
            title={t('welcome:marketingWhyTitle')}
            description={t('welcome:marketingWhyDescription')}
          />
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            {featureCards.map((card) => (
              <MarketingCard key={card.title} {...card} />
            ))}
          </div>
        </section>

        <section
          id='welcome-models'
          className='scroll-mt-16 border-y bg-muted/30'
        >
          <div className='mx-auto max-w-6xl scroll-mt-20 space-y-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'>
            <SectionHeading
              eyebrow={t('welcome:marketingModelsEyebrow')}
              title={t('welcome:marketingModelsTitle')}
              description={t('welcome:marketingModelsDescription')}
            />
            <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
              {models.map(([model, provider, input, output, cache]) => (
                <Card key={model} className='min-w-0 gap-0 py-0 shadow-xs'>
                  <CardHeader className='flex flex-row items-center gap-3 p-5'>
                    <span className='grid size-10 shrink-0 place-items-center rounded-lg border bg-background'>
                      <ModelVendorIcon modelId={model} className='size-5' />
                    </span>
                    <div className='min-w-0'>
                      <CardTitle className='font-mono text-sm leading-5 break-words text-foreground'>
                        {model}
                      </CardTitle>
                      <p className='mt-1 text-xs text-muted-foreground'>
                        {provider}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className='px-5 pb-5'>
                    <dl className='grid grid-cols-3 gap-2 border-t pt-4'>
                      {[
                        [t('welcome:marketingInput'), input],
                        [t('welcome:marketingOutput'), output],
                        [t('welcome:marketingCacheRead'), cache],
                      ].map(([label, price]) => (
                        <div key={label} className='min-w-0 space-y-1.5'>
                          <dt className='text-xs text-muted-foreground'>
                            {label}
                          </dt>
                          <dd className='font-mono text-sm font-semibold tabular-nums'>
                            {price}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className='text-sm text-muted-foreground'>
              {t('welcome:marketingModelsNote')}
            </p>
          </div>
        </section>

        <section
          id='welcome-how'
          className='mx-auto max-w-6xl scroll-mt-20 space-y-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'
        >
          <SectionHeading
            eyebrow={t('welcome:marketingHowEyebrow')}
            title={t('welcome:marketingHowTitle')}
            description={t('welcome:marketingHowDescription')}
          />
          <div className='grid gap-4 lg:grid-cols-[1fr_1.5fr_1fr] lg:items-stretch'>
            <MarketingCard
              icon={Route}
              step={1}
              title={t('welcome:marketingStepClient')}
              description={t('welcome:marketingStepClientHelp')}
            />
            <MarketingCard
              icon={Gauge}
              step={2}
              title={t('welcome:marketingStepGateway')}
              description={t('welcome:marketingStepGatewayHelp')}
              featured
            />
            <MarketingCard
              icon={CircleDollarSign}
              step={3}
              title={t('welcome:marketingStepProvider')}
              description={t('welcome:marketingStepProviderHelp')}
            />
          </div>
          <div className='rounded-xl border bg-card px-5 py-4 text-sm text-muted-foreground'>
            <strong className='text-foreground'>
              {t('welcome:marketingCompatible')}
            </strong>{' '}
            {t('welcome:marketingCompatibleHelp')}
          </div>
        </section>

        <section className='border-y bg-muted/30'>
          <div className='mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-2 lg:items-start lg:px-8'>
            <SectionHeading
              eyebrow={t('welcome:marketingControlEyebrow')}
              title={t('welcome:marketingControlTitle')}
              description={t('welcome:marketingControlDescription')}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              {[
                [
                  Users,
                  t('welcome:marketingControlUsers'),
                  t('welcome:marketingControlUsersHelp'),
                ],
                [
                  KeyRound,
                  t('welcome:marketingControlKeys'),
                  t('welcome:marketingControlKeysHelp'),
                ],
                [
                  Gauge,
                  t('welcome:marketingControlQuota'),
                  t('welcome:marketingControlQuotaHelp'),
                ],
                [
                  ShieldCheck,
                  t('welcome:marketingControlAudit'),
                  t('welcome:marketingControlAuditHelp'),
                ],
              ].map(([Icon, title, desc]) => (
                <Card
                  key={title as string}
                  className='min-w-0 gap-0 py-0 shadow-xs'
                >
                  <CardContent className='space-y-2 p-5'>
                    <Icon aria-hidden className='size-5 text-primary' />
                    <CardTitle className='text-base text-foreground'>
                      {title as string}
                    </CardTitle>
                    <p className='text-sm leading-relaxed text-muted-foreground'>
                      {desc as string}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className='mx-auto max-w-6xl space-y-8 px-4 pt-12 sm:px-6 sm:pt-16 lg:px-8'>
          <SectionHeading
            eyebrow={t('welcome:marketingConsoleEyebrow')}
            title={t('welcome:marketingConsoleTitle')}
            description={t('welcome:marketingConsoleDescription')}
          />
          <ConsolePreview />
        </section>

        <section
          id='welcome-security'
          className='mx-auto max-w-6xl scroll-mt-20 space-y-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'
        >
          <SectionHeading
            eyebrow={t('welcome:marketingSecurityEyebrow')}
            title={t('welcome:marketingSecurityTitle')}
            description={t('welcome:marketingSecurityDescription')}
          />
          <div className='overflow-hidden rounded-xl border bg-card'>
            <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 bg-muted/50 px-4 py-3 text-xs font-medium text-muted-foreground sm:px-5'>
              <span>{t('welcome:marketingSecurityColumnOne')}</span>
              <span>{t('welcome:marketingSecurityColumnTwo')}</span>
            </div>
            {securityItems.map(([label, value]) => (
              <div
                key={label}
                className='grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 border-t px-4 py-4 text-sm leading-relaxed sm:px-5'
              >
                <span className='font-semibold text-foreground'>{label}</span>
                <span className='text-muted-foreground'>{value}</span>
              </div>
            ))}
          </div>
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {[
              {
                icon: Network,
                title: t('welcome:marketingRiskIp'),
                description: t('welcome:marketingRiskIpHelp'),
              },
              {
                icon: CircleDollarSign,
                title: t('welcome:marketingRiskQuota'),
                description: t('welcome:marketingRiskQuotaHelp'),
              },
              {
                icon: Gauge,
                title: t('welcome:marketingRiskRate'),
                description: t('welcome:marketingRiskRateHelp'),
              },
              {
                icon: Route,
                title: t('welcome:marketingRiskTracking'),
                description: t('welcome:marketingRiskTrackingHelp'),
              },
              {
                icon: KeyRound,
                title: t('welcome:marketingRiskKey'),
                description: t('welcome:marketingRiskKeyHelp'),
              },
              {
                icon: ShieldCheck,
                title: t('welcome:marketingRiskPolicy'),
                description: t('welcome:marketingRiskPolicyHelp'),
              },
            ].map((item) => (
              <MarketingCard key={item.title} {...item} />
            ))}
          </div>
        </section>

        <section
          id='welcome-agents'
          className='scroll-mt-16 border-y bg-muted/30'
        >
          <div className='mx-auto max-w-6xl scroll-mt-20 space-y-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'>
            <SectionHeading
              eyebrow={t('welcome:marketingAgentsEyebrow')}
              title={t('welcome:marketingAgentsTitle')}
              description={t('welcome:marketingAgentsDescription')}
            />
            <div className='grid gap-4 lg:grid-cols-2'>
              {[
                [
                  'Claude Code',
                  `export ANTHROPIC_BASE_URL="${baseUrl}"\nexport ANTHROPIC_AUTH_TOKEN="sk-vm-xxxx"\nclaude`,
                  t('welcome:marketingClaudeHelp'),
                ],
                [
                  t('welcome:marketingAgentCodex'),
                  `model_provider = "tapmodels"\n\n[model_providers.tapmodels]\nbase_url = "${baseUrl}/v1"\nenv_key = "TAPMODELS_KEY"\nwire_api = "responses"`,
                  t('welcome:marketingCodexHelp'),
                ],
              ].map(([name, code, help]) => (
                <Card key={name} className='min-w-0 gap-4 py-0 shadow-xs'>
                  <CardHeader className='flex flex-row items-start justify-between gap-3 px-5 pt-5'>
                    <div className='min-w-0 space-y-2'>
                      <CardTitle className='text-base leading-6'>
                        {name}
                      </CardTitle>
                      <p className='text-sm leading-relaxed text-muted-foreground'>
                        {help}
                      </p>
                    </div>
                    <CopyButton
                      text={code}
                      label={t('welcome:copyConfig', { client: name })}
                      className='shrink-0'
                    />
                  </CardHeader>
                  <CardContent className='px-5 pb-5'>
                    <pre
                      className='overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-6 text-foreground'
                      tabIndex={0}
                      aria-label={name}
                    >
                      <code>{code}</code>
                    </pre>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className='rounded-xl border bg-card p-4 text-sm text-muted-foreground'>
              <strong className='text-foreground'>
                {t('welcome:marketingAlsoSupports')}
              </strong>{' '}
              {t('welcome:marketingSupportedTools')}
            </div>
          </div>
        </section>

        <section
          id='welcome-contact'
          className='mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16 lg:px-8'
        >
          <div className='rounded-xl border bg-accent/40 px-5 py-10 text-center sm:px-10 sm:py-12'>
            <h2 className='text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-3xl'>
              {t('welcome:marketingCtaTitle')}
            </h2>
            <p className='mx-auto mt-4 max-w-xl text-muted-foreground'>
              {t('welcome:marketingCtaDescription')}
            </p>
            <div className='mt-8 flex flex-wrap justify-center gap-3'>
              <Button asChild size='lg' className='px-6'>
                <Link to={consoleLink}>
                  {consoleLabel}
                  <ArrowRight aria-hidden className='size-4' />
                </Link>
              </Button>
              <Button
                variant='outline'
                size='lg'
                onClick={() => scrollToSection('welcome-models')}
              >
                {t('welcome:marketingCtaSecondary')}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

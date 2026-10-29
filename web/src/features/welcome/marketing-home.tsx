import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { DOCS_URL } from '@/config/repo'
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
import { ThemeSwitch } from '@/components/theme-switch'
import { ApiDemo } from './api-demo'
import { scrollToSection } from './scroll'

const TONE = 'text-muted-foreground'

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
      <p className={`font-mono text-xs tracking-[0.18em] uppercase ${TONE}`}>
        {eyebrow}
      </p>
      <h2 className='text-2xl leading-tight font-bold tracking-tight text-foreground md:text-3xl'>
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
}: {
  icon: typeof Route
  title: string
  description: string
  featured?: boolean
}) {
  return (
    <Card
      className={cn(
        'border-border/60 bg-card py-0 shadow-none transition-colors duration-300 hover:border-blue-500/30 hover:bg-muted/20',
        featured && 'border-blue-500/30 bg-blue-500/5'
      )}
    >
      <CardContent className='flex flex-col gap-3 p-6'>
        <Icon
          className={`size-6 ${featured ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`}
        />
        <CardTitle className='text-base text-foreground'>{title}</CardTitle>
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
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

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
      <header className='pointer-events-none fixed inset-x-0 top-0 z-40'>
        <div
          className={cn(
            'pointer-events-auto mx-auto transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
            scrolled ? 'max-w-6xl px-3 pt-3' : 'max-w-6xl px-4 md:px-6'
          )}
        >
          <nav
            aria-label={t('welcome:navigation')}
            className={cn(
              'flex items-center justify-between transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
              scrolled
                ? 'h-12 rounded-2xl bg-background/60 pr-1.5 pl-4 shadow-sm ring-[0.5px] ring-border/50 backdrop-blur-2xl'
                : 'h-16 px-2'
            )}
          >
            <button
              type='button'
              onClick={() => scrollToSection('welcome-top')}
              aria-label={brand.name}
              className='group flex min-w-0 shrink items-center gap-2.5 rounded-lg'
            >
              <span className='grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background'>
                <Logo aria-hidden className='size-4' />
              </span>
              <span className='hidden max-w-32 truncate text-sm font-semibold tracking-tight sm:inline'>
                {brand.name}
              </span>
            </button>
            <div className='hidden items-center gap-0.5 text-[13px] text-muted-foreground xl:flex'>
              {sections.map(([id, label]) => (
                <button
                  key={id}
                  type='button'
                  onClick={() => scrollToSection(id)}
                  className='rounded-lg px-3 py-1.5 transition-colors hover:text-foreground'
                >
                  {label}
                </button>
              ))}
              <a
                href={DOCS_URL}
                target='_blank'
                rel='noreferrer'
                className='rounded-lg px-3 py-1.5 hover:text-foreground'
              >
                {t('welcome:docs')}
              </a>
            </div>
            <div className='flex shrink-0 items-center gap-0.5'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant='ghost'
                    size='icon'
                    className='rounded-full xl:hidden'
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
                  <DropdownMenuItem asChild>
                    <a href={DOCS_URL} target='_blank' rel='noreferrer'>
                      {t('welcome:docs')}
                    </a>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <LanguageSelect />
              <ThemeSwitch />
              <Button
                asChild
                size='sm'
                className='group h-8 rounded-lg px-3.5 text-xs font-medium'
              >
                <Link to={consoleLink}>
                  {consoleLabel}
                  <ArrowRight className='size-3.5 transition-transform group-hover:translate-x-0.5' />
                </Link>
              </Button>
            </div>
          </nav>
        </div>
      </header>

      <div className='relative'>
        <section
          id='welcome-top'
          className='relative isolate mx-auto grid max-w-6xl items-center gap-12 px-5 pt-28 pb-20 md:px-8 md:pt-36 md:pb-28 lg:grid-cols-2 lg:gap-16'
        >
          <div
            aria-hidden
            className='pointer-events-none absolute inset-0 -z-10 opacity-25 dark:opacity-[0.12]'
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 20% 20%, oklch(0.72 0.18 250 / 80%) 0%, transparent 70%), radial-gradient(ellipse 50% 40% at 80% 15%, oklch(0.65 0.15 200 / 60%) 0%, transparent 70%), radial-gradient(ellipse 40% 35% at 40% 80%, oklch(0.70 0.12 280 / 40%) 0%, transparent 70%)',
            }}
          />
          <div
            aria-hidden
            className='pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_30%,black_20%,transparent_100%)] bg-[size:4rem_4rem] opacity-35'
          />
          <div className='welcome-fade-up min-w-0 space-y-6'>
            <Badge
              variant='outline'
              className='rounded-full border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400'
            >
              {t('welcome:marketingHeroBadge')}
            </Badge>
            <h1 className='text-[clamp(2.25rem,4.5vw,3.25rem)] leading-[1.15] font-bold tracking-tight text-foreground'>
              {t('welcome:marketingHeroTitle')}
            </h1>
            <p className='max-w-xl text-base leading-relaxed text-muted-foreground'>
              {t('welcome:marketingHeroDescription')}
            </p>
            <div className='flex flex-wrap gap-3'>
              <Button
                asChild
                size='lg'
                className='group h-11 rounded-lg px-5 text-sm font-medium'
              >
                <Link to={consoleLink}>
                  {consoleLabel}
                  <ArrowRight className='size-4' />
                </Link>
              </Button>
              <Button
                variant='outline'
                size='lg'
                className='h-11 rounded-lg border-border/50 px-5 text-sm font-medium hover:border-border hover:bg-muted/50'
                onClick={() => scrollToSection('welcome-contact')}
              >
                {t('welcome:marketingHeroSecondary')}
              </Button>
            </div>
            <div className='flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground'>
              <span>✓ {t('welcome:marketingHeroPointOne')}</span>
              <span>✓ {t('welcome:marketingHeroPointTwo')}</span>
              <span>✓ {t('welcome:marketingHeroPointThree')}</span>
            </div>
          </div>
          <div
            className='welcome-fade-up min-w-0'
            style={{ animationDelay: '180ms' }}
          >
            <ApiDemo baseUrl={baseUrl} />
          </div>
        </section>

        <section className='border-y border-border/70 bg-muted/20'>
          <div className='mx-auto grid max-w-6xl grid-cols-2 gap-8 px-5 py-10 md:grid-cols-4 md:px-8'>
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
                <div className='font-mono text-2xl font-bold text-foreground md:text-3xl'>
                  {value}
                </div>
                <div className='mt-1 text-xs text-muted-foreground/70 md:text-sm'>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className='mx-auto max-w-6xl scroll-mt-24 space-y-10 px-5 py-20 md:px-8 md:py-28'>
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
          className='scroll-mt-24 border-y border-border/70 bg-muted/15'
        >
          <div className='mx-auto max-w-6xl scroll-mt-24 space-y-10 px-5 py-20 md:px-8 md:py-28'>
            <SectionHeading
              eyebrow={t('welcome:marketingModelsEyebrow')}
              title={t('welcome:marketingModelsTitle')}
              description={t('welcome:marketingModelsDescription')}
            />
            <div className='grid gap-4 md:grid-cols-2'>
              {models.map(([model, provider, input, output, cache]) => (
                <Card
                  key={model}
                  className='border-border bg-card/80 py-0 shadow-none'
                >
                  <CardHeader className='flex-row items-center gap-3 p-5'>
                    <span className='grid size-10 place-items-center rounded-xl bg-muted font-mono text-sm text-muted-foreground'>
                      {provider[0]}
                    </span>
                    <div>
                      <CardTitle className='font-mono text-base text-foreground'>
                        {model}
                      </CardTitle>
                      <p className='mt-1 text-xs text-muted-foreground/70'>
                        {provider}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className='grid grid-cols-3 gap-3 px-5 pb-5'>
                    <div className='rounded-lg bg-muted px-3 py-2'>
                      <p className='text-xs text-muted-foreground/70'>
                        {t('welcome:marketingInput')}
                      </p>
                      <p className='font-mono text-sm font-bold text-foreground/85'>
                        {input}
                      </p>
                    </div>
                    <div className='rounded-lg bg-muted px-3 py-2'>
                      <p className='text-xs text-muted-foreground/70'>
                        {t('welcome:marketingOutput')}
                      </p>
                      <p className='font-mono text-sm font-bold text-foreground/85'>
                        {output}
                      </p>
                    </div>
                    <div className='rounded-lg bg-muted px-3 py-2'>
                      <p className='text-xs text-muted-foreground/70'>
                        {t('welcome:marketingCacheRead')}
                      </p>
                      <p className='font-mono text-sm font-bold text-foreground/85'>
                        {cache}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className='text-sm text-muted-foreground/70'>
              {t('welcome:marketingModelsNote')}
            </p>
          </div>
        </section>

        <section
          id='welcome-how'
          className='mx-auto max-w-6xl scroll-mt-24 space-y-10 px-5 py-20 md:px-8 md:py-28'
        >
          <SectionHeading
            eyebrow={t('welcome:marketingHowEyebrow')}
            title={t('welcome:marketingHowTitle')}
            description={t('welcome:marketingHowDescription')}
          />
          <div className='grid gap-4 lg:grid-cols-[1fr_1.5fr_1fr] lg:items-stretch'>
            <MarketingCard
              icon={Route}
              title={t('welcome:marketingStepClient')}
              description={t('welcome:marketingStepClientHelp')}
            />
            <MarketingCard
              icon={Gauge}
              title={t('welcome:marketingStepGateway')}
              description={t('welcome:marketingStepGatewayHelp')}
              featured
            />
            <MarketingCard
              icon={CircleDollarSign}
              title={t('welcome:marketingStepProvider')}
              description={t('welcome:marketingStepProviderHelp')}
            />
          </div>
          <div className='rounded-xl border border-border bg-card/60 px-5 py-4 text-sm text-muted-foreground'>
            <strong className='text-foreground'>
              {t('welcome:marketingCompatible')}
            </strong>{' '}
            {t('welcome:marketingCompatibleHelp')}
          </div>
        </section>

        <section className='border-y border-border/70 bg-muted/15'>
          <div className='mx-auto grid max-w-6xl gap-10 px-5 py-20 md:px-8 md:py-28 lg:grid-cols-2 lg:items-start'>
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
                  className='border-border bg-card/75 py-0 shadow-none'
                >
                  <CardContent className='space-y-2 p-5'>
                    <Icon className='size-5 text-primary' />
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

        <section className='mx-auto max-w-6xl space-y-8 px-5 py-20 md:px-8 md:py-28'>
          <SectionHeading
            eyebrow={t('welcome:marketingConsoleEyebrow')}
            title={t('welcome:marketingConsoleTitle')}
            description={t('welcome:marketingConsoleDescription')}
          />
          <div className='grid gap-4 md:grid-cols-3'>
            {[
              [
                '/welcome/dashboard.png',
                t('welcome:marketingConsoleDashboard'),
              ],
              ['/welcome/usage-log.png', t('welcome:marketingConsoleUsage')],
              ['/welcome/api-keys.png', t('welcome:marketingConsoleKeys')],
            ].map(([src, alt]) => (
              <Card
                key={src}
                className='overflow-hidden border-border bg-card/80 py-0 shadow-none'
              >
                <img
                  src={`${import.meta.env.BASE_URL}${src.replace(/^\//, '')}`}
                  alt={alt}
                  className='h-auto w-full'
                />
              </Card>
            ))}
          </div>
        </section>

        <section
          id='welcome-security'
          className='mx-auto max-w-6xl scroll-mt-24 space-y-10 px-5 py-20 md:px-8 md:py-28'
        >
          <SectionHeading
            eyebrow={t('welcome:marketingSecurityEyebrow')}
            title={t('welcome:marketingSecurityTitle')}
            description={t('welcome:marketingSecurityDescription')}
          />
          <div className='overflow-hidden rounded-2xl border border-border'>
            <div className='grid grid-cols-[0.8fr_1.2fr] bg-card px-5 py-3 text-xs font-medium text-muted-foreground/70'>
              <span>{t('welcome:marketingSecurityColumnOne')}</span>
              <span>{t('welcome:marketingSecurityColumnTwo')}</span>
            </div>
            {securityItems.map(([label, value]) => (
              <div
                key={label}
                className='grid grid-cols-[0.8fr_1.2fr] border-t border-border px-5 py-4 text-sm'
              >
                <span className='font-semibold text-foreground/85'>
                  {label}
                </span>
                <span className='text-muted-foreground'>{value}</span>
              </div>
            ))}
          </div>
          <div className='grid gap-4 sm:grid-cols-3'>
            {[
              t('welcome:marketingRiskIp'),
              t('welcome:marketingRiskQuota'),
              t('welcome:marketingRiskKey'),
            ].map((item) => (
              <div
                key={item}
                className='flex items-center gap-2 rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground'
              >
                <Check className='size-4 text-primary' />
                {item}
              </div>
            ))}
          </div>
        </section>

        <section
          id='welcome-agents'
          className='scroll-mt-24 border-y border-border/70 bg-muted/15'
        >
          <div className='mx-auto max-w-6xl scroll-mt-24 space-y-10 px-5 py-20 md:px-8 md:py-28'>
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
                <Card
                  key={name}
                  className='border-border bg-card py-0 shadow-none'
                >
                  <CardHeader className='p-6 pb-3'>
                    <CopyButton
                      text={code}
                      label={t('welcome:copyConfig', { client: name })}
                      className='justify-self-end'
                    />
                    <CardTitle className='font-mono text-xl text-foreground'>
                      {name}
                    </CardTitle>
                    <p className='text-sm text-muted-foreground'>{help}</p>
                  </CardHeader>
                  <CardContent className='p-6 pt-0'>
                    <pre className='overflow-x-auto rounded-xl bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre text-primary'>
                      {code}
                    </pre>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className='rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground'>
              <strong className='text-foreground/85'>
                {t('welcome:marketingAlsoSupports')}
              </strong>{' '}
              {t('welcome:marketingSupportedTools')}
            </div>
          </div>
        </section>

        <section
          id='welcome-contact'
          className='mx-auto max-w-6xl scroll-mt-24 px-5 py-20 md:px-8 md:py-28'
        >
          <div className='rounded-2xl border border-border/50 bg-gradient-to-br from-blue-500/5 via-background to-violet-500/5 px-6 py-16 text-center md:px-12'>
            <h2 className='text-3xl font-bold tracking-tight text-foreground md:text-4xl'>
              {t('welcome:marketingCtaTitle')}
            </h2>
            <p className='mx-auto mt-4 max-w-xl text-muted-foreground'>
              {t('welcome:marketingCtaDescription')}
            </p>
            <div className='mt-8 flex flex-wrap justify-center gap-3'>
              <Button asChild size='lg' className='group rounded-lg px-6'>
                <Link to={consoleLink}>
                  {consoleLabel}
                  <ArrowRight className='size-4' />
                </Link>
              </Button>
              <Button
                variant='outline'
                size='lg'
                className='rounded-lg border-border/50 hover:border-border hover:bg-muted/50'
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

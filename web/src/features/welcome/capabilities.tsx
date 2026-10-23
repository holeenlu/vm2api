import { t } from '@/i18n'
import {
  Activity,
  Boxes,
  Cpu,
  Network,
  ScrollText,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { Reveal } from './reveal'

const PROTOCOLS = [
  { path: '/v1/messages', spec: 'Anthropic' },
  { path: '/v1/chat/completions', spec: 'OpenAI Chat' },
  { path: '/v1/responses', spec: 'OpenAI Responses' },
  {
    path: '/v1/models',
    get spec() {
      return t('welcome:modelCatalog')
    },
  },
  {
    path: '/v1/messages/count_tokens',
    get spec() {
      return t('welcome:countTokens')
    },
  },
  {
    get path() {
      return t('welcome:sse')
    },
    get spec() {
      return t('welcome:verbatim')
    },
  },
] as const

const MORE = [
  {
    Icon: Cpu,
    get title() {
      return t('welcome:containerKvm')
    },
    get desc() {
      return t('welcome:containerHelp')
    },
  },
  {
    Icon: Network,
    get title() {
      return t('welcome:clusterNodes')
    },
    get desc() {
      return t('welcome:clusterHelp')
    },
  },
  {
    Icon: ScrollText,
    get title() {
      return t('welcome:requestLogs')
    },
    get desc() {
      return t('welcome:logsHelp')
    },
  },
  {
    Icon: Users,
    get title() {
      return t('welcome:multiUser')
    },
    get desc() {
      return t('welcome:multiUserHelp')
    },
  },
] as const

export function WelcomeCapabilities() {
  const { t } = useTranslation('welcome')

  const PIPELINE = [
    t('welcome:sanitize'),
    t('welcome:riskAudit'),
    t('welcome:scheduling'),
  ] as const

  return (
    <section
      id='welcome-features'
      className='relative z-10 scroll-mt-20 px-6 py-24 md:py-32'
    >
      <div className='mx-auto max-w-6xl'>
        <Reveal className='mb-16 max-w-lg'>
          <p className='mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase'>
            {t('welcome:capabilities')}
          </p>
          <h2 className='text-2xl leading-tight font-bold tracking-tight md:text-3xl'>
            <Trans
              t={t}
              i18nKey='welcome:capabilitiesTitle'
              components={{ break: <br /> }}
            />
          </h2>
        </Reveal>
        <div className='grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3'>
          <Reveal
            animation='scale-in'
            className='group bg-background p-7 transition-colors duration-300 hover:bg-muted/20 md:col-span-2 md:p-8'
          >
            <CellHead num='01' title={t('welcome:protocolCompatibility')} />
            <p className='text-sm leading-relaxed text-muted-foreground'>
              {t('welcome:protocolHelp')}
            </p>
            <ul className='mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3'>
              {PROTOCOLS.map((p) => (
                <li
                  key={p.path}
                  className='flex flex-col gap-0.5 rounded-lg border border-border/30 bg-muted/20 px-3 py-2 transition-colors duration-300 hover:border-blue-500/30 hover:bg-blue-500/5'
                >
                  <code className='truncate font-mono text-[11.5px]'>
                    {p.path}
                  </code>
                  <span className='text-[11px] text-muted-foreground'>
                    {p.spec}
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal
            animation='scale-in'
            delay={100}
            className='group bg-background p-7 transition-colors duration-300 hover:bg-muted/20 md:p-8'
          >
            <CellHead num='02' title={t('welcome:slotIsolation')} />
            <p className='text-sm leading-relaxed text-muted-foreground'>
              {t('welcome:isolationHelp')}
            </p>
            <div className='mt-5 flex items-center justify-center'>
              <div className='relative'>
                <div className='flex size-16 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/5'>
                  <Boxes
                    aria-hidden
                    className='size-7 text-emerald-500/70'
                    strokeWidth={1.5}
                  />
                </div>
                <span className='absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-emerald-500'>
                  <ShieldCheck aria-hidden className='size-2.5 text-white' />
                </span>
              </div>
            </div>
          </Reveal>

          <Reveal
            animation='scale-in'
            delay={200}
            className='group bg-background p-7 transition-colors duration-300 hover:bg-muted/20 md:p-8'
          >
            <CellHead num='03' title={t('welcome:preflight')} />
            <p className='text-sm leading-relaxed text-muted-foreground'>
              {t('welcome:preflightHelp')}
            </p>
            <ol className='mt-4 space-y-2'>
              {PIPELINE.map((step, i) => (
                <li key={step} className='flex items-center gap-2'>
                  <span
                    className={
                      i === 1
                        ? 'flex size-6 items-center justify-center rounded-full border border-blue-500/30 bg-blue-500/20 text-[10px] font-bold text-blue-500'
                        : 'flex size-6 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-bold text-muted-foreground'
                    }
                  >
                    {i + 1}
                  </span>
                  <span className='h-px flex-1 bg-border/40' />
                  <span className='text-xs text-muted-foreground'>{step}</span>
                </li>
              ))}
            </ol>
          </Reveal>

          <Reveal
            animation='scale-in'
            delay={300}
            className='group bg-background p-7 transition-colors duration-300 hover:bg-muted/20 md:col-span-2 md:p-8'
          >
            <CellHead num='04' title={t('welcome:quotaScheduling')} />
            <p className='text-sm leading-relaxed text-muted-foreground'>
              {t('welcome:quotaSchedulingHelp')}
            </p>
            <div className='mt-4 grid gap-2 sm:grid-cols-2'>
              {[
                { label: t('welcome:fiveHourWindow'), pct: 42 },
                { label: t('welcome:sevenDayWindow'), pct: 68 },
              ].map((w) => (
                <div
                  key={w.label}
                  className='rounded-lg border border-border/30 bg-muted/20 px-3 py-2.5'
                >
                  <div className='flex items-center justify-between text-xs'>
                    <span className='text-muted-foreground'>{w.label}</span>
                    <Activity
                      aria-hidden
                      className='size-3.5 text-violet-500/70'
                    />
                  </div>
                  <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className='h-full rounded-full bg-gradient-to-r from-blue-400 to-violet-500'
                      style={{ width: `${w.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className='mt-2 text-[11px] text-muted-foreground/70'>
              {t('welcome:quotaIllustration')}
            </p>
          </Reveal>
        </div>

        <div className='mt-12 grid grid-cols-2 gap-8 md:grid-cols-4 md:gap-12'>
          {MORE.map(({ Icon, title, desc }, i) => (
            <Reveal
              key={title}
              delay={i * 100}
              className='flex flex-col items-center text-center'
            >
              <div className='mb-3 flex size-12 items-center justify-center rounded-xl border border-border/50 bg-muted/30 text-muted-foreground'>
                <Icon aria-hidden className='size-5' strokeWidth={1.5} />
              </div>
              <h3 className='mb-1.5 text-sm font-semibold'>{title}</h3>
              <p className='max-w-[200px] text-xs leading-relaxed text-muted-foreground'>
                {desc}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

function CellHead({ num, title }: { num: string; title: string }) {
  useTranslation('welcome')

  return (
    <div className='mb-3 flex items-center gap-3'>
      <span className='flex size-7 items-center justify-center rounded-md border border-border/40 bg-muted text-[10px] font-semibold text-muted-foreground tabular-nums'>
        {num}
      </span>
      <h3 className='text-sm font-semibold'>{title}</h3>
    </div>
  )
}

import { Link } from '@tanstack/react-router'
import type { ViewId } from '@/config/nav'
import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { hasPanelView } from './steps'

type GuideTo =
  | '/overview'
  | '/statistics'
  | '/groups'
  | '/billing'
  | '/subscriptions'
  | '/ops'
  | '/users'
  | '/logs'
  | '/cluster'
  | '/vm'
  | '/import'
  | '/specs'
  | '/proxies'
  | '/models'
  | '/risk'
  | '/system'
  | '/keys'
  | '/anthropic'
  | '/wrap'
  | '/database'
  | '/settings/$tab'

type GuideItem = {
  title: string
  view: ViewId
  to: GuideTo
  summary: string
  detail?: string
}

const GROUPS: { title: string; items: GuideItem[] }[] = [
  {
    get title() {
      return t('welcome:monitoring')
    },
    items: [
      {
        get title() {
          return t('welcome:overview')
        },
        view: 'overview',
        to: '/overview',
        get summary() {
          return t('welcome:overviewHelp')
        },
      },
      {
        get title() {
          return t('welcome:statistics')
        },
        view: 'statistics',
        to: '/statistics',
        get summary() {
          return t('welcome:statisticsHelp')
        },
      },
      {
        get title() {
          return t('welcome:logs')
        },
        view: 'logs',
        to: '/logs',
        get summary() {
          return t('welcome:logPageHelp')
        },
      },
      {
        get title() {
          return t('welcome:operations')
        },
        view: 'ops',
        to: '/ops',
        get summary() {
          return t('welcome:operationsHelp')
        },
      },
    ],
  },
  {
    get title() {
      return t('welcome:resources')
    },
    items: [
      {
        get title() {
          return t('welcome:groups')
        },
        view: 'groups',
        to: '/groups',
        get summary() {
          return t('welcome:groupsHelp')
        },
      },
      {
        get title() {
          return t('welcome:cluster')
        },
        view: 'cluster',
        to: '/cluster',
        get summary() {
          return t('welcome:clusterPageHelp')
        },
      },
      {
        get title() {
          return t('welcome:vms')
        },
        view: 'vm',
        to: '/vm',
        get summary() {
          return t('welcome:vmUsageHelp')
        },
        get detail() {
          return t('welcome:vmControlsHelp')
        },
      },
      {
        get title() {
          return t('welcome:import')
        },
        view: 'import',
        to: '/import',
        get summary() {
          return t('welcome:importHelp')
        },
      },
      {
        get title() {
          return t('welcome:specs')
        },
        view: 'specs',
        to: '/specs',
        get summary() {
          return t('welcome:specsHelp')
        },
      },
      {
        get title() {
          return t('welcome:proxies')
        },
        view: 'proxies',
        to: '/proxies',
        get summary() {
          return t('welcome:proxiesHelp')
        },
      },
    ],
  },
  {
    get title() {
      return t('welcome:protocols')
    },
    items: [
      {
        get title() {
          return t('welcome:models')
        },
        view: 'models',
        to: '/models',
        get summary() {
          return t('welcome:modelsHelp')
        },
      },
      {
        get title() {
          return t('welcome:riskAudit')
        },
        view: 'risk',
        to: '/risk',
        get summary() {
          return t('welcome:auditHelp')
        },
        get detail() {
          return t('welcome:auditModeHelp')
        },
      },
      {
        get title() {
          return t('welcome:systemPrompts')
        },
        view: 'system',
        to: '/system',
        get summary() {
          return t('welcome:promptsHelp')
        },
      },
      {
        get title() {
          return t('welcome:keys')
        },
        view: 'keys',
        to: '/keys',
        get summary() {
          return t('welcome:keysHelp')
        },
        get detail() {
          return t('welcome:keyFundingHelp')
        },
      },
      {
        title: 'Anthropic',
        view: 'anthropic',
        to: '/anthropic',
        get summary() {
          return t('welcome:directApiHelp')
        },
        get detail() {
          return t('welcome:directApiConfigHelp')
        },
      },
    ],
  },
  {
    get title() {
      return t('welcome:system')
    },
    items: [
      {
        get title() {
          return t('welcome:billing')
        },
        view: 'billing',
        to: '/billing',
        get summary() {
          return t('welcome:billingHelp')
        },
      },
      {
        get title() {
          return t('welcome:subscriptions')
        },
        view: 'subscriptions',
        to: '/subscriptions',
        get summary() {
          return t('welcome:subscriptionsHelp')
        },
      },
      {
        get title() {
          return t('welcome:users')
        },
        view: 'users',
        to: '/users',
        get summary() {
          return t('welcome:usersHelp')
        },
      },
      {
        get title() {
          return t('welcome:settings')
        },
        view: 'settings',
        to: '/settings/$tab',
        get summary() {
          return t('welcome:settingsHelp')
        },
        get detail() {
          return t('welcome:quotaModeHelp')
        },
      },
      {
        get title() {
          return t('welcome:kernel')
        },
        view: 'wrap',
        to: '/wrap',
        get summary() {
          return t('welcome:kernelHelp')
        },
        get detail() {
          return t('welcome:reinstallHelp')
        },
      },
      {
        get title() {
          return t('welcome:database')
        },
        view: 'database',
        to: '/database',
        get summary() {
          return t('welcome:databaseHelp')
        },
      },
    ],
  },
]

function GuideTitle({ item }: { item: GuideItem }) {
  useTranslation('welcome')

  const className =
    'text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  if (item.to === '/settings/$tab') {
    return (
      <Link to='/settings/$tab' params={{ tab: 'quota' }} className={className}>
        {item.title}
      </Link>
    )
  }
  return (
    <Link to={item.to} className={className}>
      {item.title}
    </Link>
  )
}

export function WelcomeModuleGuide({ views }: { views?: string[] | null }) {
  const { t } = useTranslation('welcome')

  const visibleGroups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasPanelView(views, item.view)),
  })).filter((group) => group.items.length > 0)
  return (
    <section
      className='relative z-10 px-6 pt-2 pb-8'
      aria-labelledby='welcome-modules'
    >
      <div className='mx-auto flex max-w-6xl flex-col gap-6 rounded-2xl border bg-card p-4 shadow-xs sm:p-6'>
        <h2
          id='welcome-modules'
          className='text-xl font-semibold tracking-tight sm:text-2xl'
        >
          {t('welcome:moduleGuide')}
        </h2>
        <div className='grid gap-6 lg:grid-cols-2'>
          {visibleGroups.map((group) => (
            <div key={group.items[0].view} className='min-w-0'>
              <h3 className='mb-2 text-sm font-medium'>{group.title}</h3>
              <dl className='divide-y rounded-2xl border bg-background/70'>
                {group.items.map((item) => {
                  return (
                    <div key={item.view} className='px-3 py-2.5'>
                      <dt>
                        <GuideTitle item={item} />
                      </dt>
                      <dd className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>
                        {item.summary}
                        {item.detail ? ` ${item.detail}` : ''}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

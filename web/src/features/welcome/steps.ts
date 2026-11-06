import type { ViewId } from '@/config/nav'
import { DOCS_URL } from '@/config/repo'
import { t } from '@/i18n'

export type OnboardingStepId =
  | 'service_group'
  | 'admin_password'
  | 'egress'
  | 'slot_account'
  | 'schedulable'
  | 'api_key'
  | 'first_request'

export type StepPanelTo =
  '/groups' | '/users' | '/proxies' | '/import' | '/vm' | '/keys' | '/logs'

export type StepMeta = {
  id: OnboardingStepId
  title: string
  description: string
  panelTo: StepPanelTo
  panelView: ViewId
  docsPath: string
}

export const STEP_META: Record<OnboardingStepId, StepMeta> = {
  service_group: {
    id: 'service_group',
    get title() {
      return t('welcome:stepServices')
    },
    get description() {
      return t('welcome:stepServicesHelp')
    },
    panelTo: '/groups',
    panelView: 'groups',
    docsPath: 'guide/api',
  },
  admin_password: {
    id: 'admin_password',
    get title() {
      return t('welcome:stepPassword')
    },
    get description() {
      return t('welcome:stepPasswordHelp')
    },
    panelTo: '/users',
    panelView: 'users',
    docsPath: 'guide/console/users',
  },
  egress: {
    id: 'egress',
    get title() {
      return t('welcome:stepEgress')
    },
    get description() {
      return t('welcome:stepEgressHelp')
    },
    panelTo: '/proxies',
    panelView: 'proxies',
    docsPath: 'guide/console/proxies',
  },
  slot_account: {
    id: 'slot_account',
    get title() {
      return t('welcome:stepAccount')
    },
    get description() {
      return t('welcome:stepAccountHelp')
    },
    panelTo: '/import',
    panelView: 'import',
    docsPath: 'guide/console/import',
  },
  schedulable: {
    id: 'schedulable',
    get title() {
      return t('welcome:stepSchedule')
    },
    get description() {
      return t('welcome:stepScheduleHelp')
    },
    panelTo: '/vm',
    panelView: 'vm',
    docsPath: 'guide/slots',
  },
  api_key: {
    id: 'api_key',
    get title() {
      return t('welcome:stepKey')
    },
    get description() {
      return t('welcome:stepKeyHelp')
    },
    panelTo: '/keys',
    panelView: 'keys',
    docsPath: 'guide/console/keys',
  },
  first_request: {
    id: 'first_request',
    get title() {
      return t('welcome:stepRequest')
    },
    get description() {
      return t('welcome:stepRequestHelp')
    },
    panelTo: '/logs',
    panelView: 'logs',
    docsPath: 'guide/api',
  },
}

export function isOnboardingStepId(id: string): id is OnboardingStepId {
  return id in STEP_META
}

/** Docs site is rooted at /zh/; pass a path like `guide/clients`. */
export function docsHref(relativePath: string): string {
  const base = DOCS_URL.endsWith('/') ? DOCS_URL : `${DOCS_URL}/`
  return `${base}${relativePath.replace(/^\//, '')}`
}

/** Missing views list = admin default (show the link). */
export function hasPanelView(
  views: string[] | null | undefined,
  view: ViewId
): boolean {
  if (views == null) return true
  return views.includes(view) || views.includes(`/${view}`)
}

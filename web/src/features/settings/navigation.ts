import {
  Activity,
  Archive,
  BellRing,
  Bot,
  Fingerprint,
  Gauge,
  Info,
  Layers,
  Magnet,
  Network,
  PackageCheck,
  RadioTower,
  ScrollText,
  type LucideIcon,
} from 'lucide-react'

export const SETTINGS_TABS = [
  ['branding', 'nav.branding'],
  ['sticky', 'nav.sticky'],
  ['pool', 'nav.pool'],
  ['quota', 'nav.quota'],
  ['openai', 'nav.openai'],
  ['logs', 'logs.title'],
  ['protocol', 'nav.protocol'],
  ['init', 'nav.init'],
  ['health', 'nav.health'],
  ['notify', 'nav.notify'],
  ['telemetry', 'nav.telemetry'],
  ['socks5', 'nav.socks5'],
  ['backup', 'backup.title'],
  ['about', 'nav.about'],
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number][0]

/**
 * 设置页左侧分组导航。id 必须来自 SETTINGS_TABS（类型层面约束），
 * 分组只改呈现顺序，不改路由与合法 tab 集合。每个 tab 只出现一次。
 */
export const SETTINGS_NAV_GROUPS: {
  label: string
  items: { id: SettingsTabId; icon: LucideIcon }[]
}[] = [
  {
    label: 'nav.scheduling',
    items: [
      { id: 'sticky', icon: Magnet },
      { id: 'pool', icon: Layers },
      { id: 'quota', icon: Gauge },
      { id: 'openai', icon: Bot },
    ],
  },
  {
    label: 'nav.protocol',
    items: [{ id: 'protocol', icon: Fingerprint }],
  },
  {
    label: 'nav.slots',
    items: [
      { id: 'init', icon: PackageCheck },
      { id: 'health', icon: Activity },
      { id: 'telemetry', icon: RadioTower },
      { id: 'socks5', icon: Network },
    ],
  },
  {
    label: 'nav.operations',
    items: [
      { id: 'branding', icon: Fingerprint },
      { id: 'notify', icon: BellRing },
      { id: 'logs', icon: ScrollText },
      { id: 'backup', icon: Archive },
      { id: 'about', icon: Info },
    ],
  },
]

export const SETTINGS_TAB_LABELS = Object.fromEntries(SETTINGS_TABS) as Record<
  SettingsTabId,
  string
>

export function settingsTabId(tab: string | undefined): SettingsTabId {
  return SETTINGS_TABS.some((item) => item[0] === tab)
    ? (tab as SettingsTabId)
    : 'sticky'
}

export const SETTINGS_NAV_ITEMS = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items
)

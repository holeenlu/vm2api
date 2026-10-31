import { t as translate } from '@/i18n'

/** 可隐藏列，顺序 = 下拉菜单顺序（hub `DEFAULT_VISIBLE_COLUMNS`）。时间/模型/状态恒显示。 */
export const LOGS_TABLE_COLUMNS = [
  {
    id: 'user',
    get label() {
      return translate('logs:user')
    },
  },
  {
    id: 'key',
    get label() {
      return translate('logs:key')
    },
  },
  {
    id: 'ip',
    get label() {
      return translate('logs:ip')
    },
  },
  {
    id: 'reasoningEffort',
    get label() {
      return translate('logs:reasoningEffort')
    },
  },
  {
    id: 'tokens',
    get label() {
      return translate('logs:tokens')
    },
  },
  {
    id: 'cache',
    get label() {
      return translate('logs:cache')
    },
  },
  {
    id: 'performance',
    get label() {
      return translate('logs:performance')
    },
  },
  {
    id: 'cost',
    get label() {
      return translate('logs:actualCharge')
    },
  },
] as const

export type LogsTableColumn = (typeof LOGS_TABLE_COLUMNS)[number]['id']

export const DEFAULT_HIDDEN_COLUMNS: LogsTableColumn[] = ['ip']

const VALID: Record<string, true> = Object.fromEntries(
  LOGS_TABLE_COLUMNS.map((col) => [col.id, true])
)

/** 按面板用户分键，同一浏览器切换账号互不串。 */
function storageKey(user: string): string {
  return `tapmodels-columns:usage-logs:${user}`
}

export function readHiddenColumns(user: string): LogsTableColumn[] {
  try {
    const raw = localStorage.getItem(storageKey(user))
    if (raw == null) return DEFAULT_HIDDEN_COLUMNS
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_HIDDEN_COLUMNS
    return parsed.filter(
      (id): id is LogsTableColumn => typeof id === 'string' && VALID[id]
    )
  } catch {
    return DEFAULT_HIDDEN_COLUMNS
  }
}

export function writeHiddenColumns(
  user: string,
  hidden: readonly LogsTableColumn[]
) {
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(hidden))
  } catch {
    // 隐私模式 / 配额满：本次会话内仍按内存状态生效。
  }
}

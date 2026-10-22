import { t } from '@/i18n'
import type { ErrorOwner } from '@/types/panel-logs'

const LS_LOG_MUTE = 'kin_log_muted_classes'

/** 后端 `ERROR_CLASSES` 的完整镜像（`error-class.mjs`）。仅 ID 与 owner 是契约，label 在读取时按当前语言显示。 */
export const ERROR_CLASS_META: Record<
  string,
  { label: string; owner: ErrorOwner }
> = {
  auth: {
    get label() {
      return t('lib:errorClass.auth')
    },
    owner: 'client',
  },
  request: {
    get label() {
      return t('lib:errorClass.request')
    },
    owner: 'client',
  },
  signature: {
    get label() {
      return t('lib:errorClass.signature')
    },
    owner: 'client',
  },
  rate_limit: {
    get label() {
      return t('lib:errorClass.rateLimit')
    },
    owner: 'provider',
  },
  quota: {
    get label() {
      return t('lib:errorClass.quota')
    },
    owner: 'platform',
  },
  overloaded: {
    get label() {
      return t('lib:errorClass.overloaded')
    },
    owner: 'provider',
  },
  unavailable: {
    get label() {
      return t('lib:errorClass.unavailable')
    },
    owner: 'platform',
  },
  timeout: {
    get label() {
      return t('lib:errorClass.timeout')
    },
    owner: 'provider',
  },
  credential: {
    get label() {
      return t('lib:errorClass.credential')
    },
    owner: 'platform',
  },
  proxy: {
    get label() {
      return t('lib:errorClass.proxy')
    },
    owner: 'platform',
  },
  upstream: {
    get label() {
      return t('lib:errorClass.upstream')
    },
    owner: 'provider',
  },
  other: {
    get label() {
      return t('lib:errorClass.other')
    },
    owner: 'platform',
  },
  distill: {
    get label() {
      return t('lib:errorClass.distill')
    },
    owner: 'platform',
  },
  refusal: {
    get label() {
      return t('lib:errorClass.refusal')
    },
    owner: 'provider',
  },
}

export const ERROR_CLASS_IDS = Object.keys(ERROR_CLASS_META)

/** 后端 `DEFAULT_MUTED_ERROR_CLASSES`：字段缺失时的回落值。 */
export const DEFAULT_MUTED_CLASSES = ['auth']

/**
 * SQL 层只能真正排除 `auth`（`error-class.mjs` 的 `excludeErrorClassSql`）——
 * `error_class` 是读出后派生的，不是 DB 列。屏蔽其余类时后端只在内存删当页行，
 * 导致 `total` 偏大、每页条数不足。UI 需为此标注计数近似。
 */
export function isExactlyMutable(id: string): boolean {
  return id === 'auth'
}

/** 当前屏蔽集里是否含 SQL 层排除不掉的类 → 计数需标注「近似」。 */
export function hasApproximateCount(muted: string[]): boolean {
  return muted.some((id) => !isExactlyMutable(id))
}

function normalize(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const seen = new Set<string>()
  for (const item of list) {
    const id = String(item).trim()
    if (id && id in ERROR_CLASS_META) seen.add(id)
  }
  return [...seen]
}

function readLocal(): string[] | null {
  try {
    const raw = localStorage.getItem(LS_LOG_MUTE)
    if (raw == null) return null
    const parsed: unknown = JSON.parse(raw)
    return normalize(parsed)
  } catch {
    return null
  }
}

/**
 * 三级回退读取屏蔽列表：localStorage → 服务端快照 → 默认 `['auth']`。
 *
 * 服务端的 `muted_error_classes` **可能整个 key 缺失**（`routing.json` 里没这个字段），
 * 那种情况下必须回落 `['auth']` 而不是 `[]` —— 显式 `[]` 是「不屏蔽任何类」的另一种状态。
 */
export function resolveMutedClasses(
  serverValue?: string[] | null | undefined
): string[] {
  const local = readLocal()
  if (local) return local
  if (serverValue != null) return normalize(serverValue)
  return [...DEFAULT_MUTED_CLASSES]
}

export function writeMutedClasses(classes: string[]): void {
  try {
    localStorage.setItem(LS_LOG_MUTE, JSON.stringify(normalize(classes)))
  } catch {
    /* localStorage 不可用时静默降级为纯内存 */
  }
}

/**
 * 掩码入站 Key。后端**不掩码**，只截断到 240 字符，且值是攻击者可控字符串。
 * 保留前 8 后 4 便于运维比对，中间恒定替换。
 *
 * 调用方仍需遵守：不放进 `title=`、不给复制按钮、不写 console / toast。
 */
export function maskPresentedKey(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (!value) return '—'
  if (value.length <= 14) return '••••••••'
  return `${value.slice(0, 8)}••••••••${value.slice(-4)}`
}

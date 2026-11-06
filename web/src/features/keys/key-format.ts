import { i18n, t } from '@/i18n'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { StatusTone } from '@/types/status'
import { fmtNum, fmtUsd } from '@/lib/format'

export function maskApiKeyItem(k: ApiKeyItem): string {
  const raw = String(k.key || '')
  if (raw.includes('…') || raw.includes('...')) return raw
  const prefix = k.key_prefix || k.prefix || ''
  const suffix = k.key_suffix || ''
  if (raw.startsWith('hmac:')) {
    return suffix ? `${prefix || raw.slice(0, 10)}…${suffix}` : prefix || '—'
  }
  if (raw.length > 16) return `${raw.slice(0, 8)}…${raw.slice(-4)}`
  if (prefix && suffix) return `${prefix}…${suffix}`
  return prefix || raw || 'sk-vm-…'
}

export function keyIsExpired(k: ApiKeyItem): boolean {
  if (!k.expires_at) return false
  const timestamp = Date.parse(k.expires_at)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

/**
 * 额度用完：USD 额度由计费写入时把状态翻成 quota_exhausted；次数额度不改状态、
 * 鉴权时直接拒，所以两种都按用量再判一次。
 */
export function keyQuotaExhausted(k: ApiKeyItem): boolean {
  if (k.status === 'quota_exhausted') return true
  const req = Number(k.quota_requests || 0)
  if (req > 0 && Number(k.quota_used || 0) >= req) return true
  const usd = Number(k.quota_usd || 0)
  return usd > 0 && Number(k.quota_usd_used || 0) >= usd
}

export function keyIsDead(k: ApiKeyItem): boolean {
  return k.status === 'disabled' || keyIsExpired(k) || keyQuotaExhausted(k)
}

export function keyStatusTone(k: ApiKeyItem): StatusTone {
  if (k.status === 'disabled') {
    return {
      key: 'off',
      text: t('keys:disabled'),
      cls: 'off',
      label: t('keys:disabled'),
    }
  }
  if (keyIsExpired(k)) {
    return {
      key: 'bad',
      text: t('keys:expired'),
      cls: 'bad',
      label: t('keys:expired'),
    }
  }
  if (keyQuotaExhausted(k)) {
    return {
      key: 'bad',
      text: t('keys:quotaExhausted'),
      cls: 'bad',
      label: t('keys:quotaExhausted'),
    }
  }
  return {
    key: 'ok',
    text: t('keys:enabled'),
    cls: 'ok',
    label: t('keys:enabled'),
  }
}

function relMs(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000)
  const [value, unit] =
    s < 60
      ? ([s, 'second'] as const)
      : s < 3600
        ? ([Math.round(s / 60), 'minute'] as const)
        : s < 86400
          ? ([Math.round(s / 3600), 'hour'] as const)
          : ([Math.round(s / 86400), 'day'] as const)
  return new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
  }).format(value)
}

export function keyExpiryText(k: ApiKeyItem): {
  text: string
  expired: boolean
} {
  if (!k.expires_at) return { text: t('keys:permanent'), expired: false }
  const timestamp = Date.parse(k.expires_at)
  if (!Number.isFinite(timestamp))
    return { text: String(k.expires_at), expired: false }
  const d = timestamp - Date.now()
  if (d <= 0) return { text: t('keys:expired'), expired: true }
  return { text: t('keys:expiresIn', { duration: relMs(d) }), expired: false }
}

/** 次数额度和 USD 额度各自显示；两项都没设才算「不限」。 */
export function keyQuotaLabel(k: ApiKeyItem): string {
  const q = Number(k.quota_requests || 0)
  const u = Number(k.quota_used || 0)
  const usd = Number(k.quota_usd || 0)
  const usdUsed = Number(k.quota_usd_used || 0)
  const parts: string[] = []
  if (q)
    parts.push(
      t('keys:requestQuota', { used: fmtNum(u), limit: fmtNum(q), count: q })
    )
  if (usd) parts.push(`${fmtUsd(usdUsed)} / ${fmtUsd(usd)}`)
  if (parts.length) return parts.join(' · ')
  return usdUsed
    ? t('keys:unlimitedUsageCost', { used: fmtNum(u), cost: fmtUsd(usdUsed) })
    : t('keys:unlimitedUsage', { used: fmtNum(u) })
}

/** 进度条取两种额度里用得更多的那个。 */
export function keyQuotaPct(k: ApiKeyItem): number | null {
  const pcts: number[] = []
  const q = Number(k.quota_requests || 0)
  if (q) pcts.push((Number(k.quota_used || 0) / q) * 100)
  const usd = Number(k.quota_usd || 0)
  if (usd) pcts.push((Number(k.quota_usd_used || 0) / usd) * 100)
  if (!pcts.length) return null
  return Math.min(100, Math.max(...pcts))
}

export function plaintextFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const rec = payload as Record<string, unknown>
  const direct = rec.key
  if (isPlainKey(direct)) return direct
  const item = rec.item
  if (item && typeof item === 'object') {
    const nested = (item as Record<string, unknown>).key
    if (isPlainKey(nested)) return nested
  }
  return ''
}

function isPlainKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (value.includes('…') || value.includes('...')) return false
  if (value.startsWith('hmac:')) return false
  return value.length > 12
}

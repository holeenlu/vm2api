import type { VmUsageStatsDay, VmUsageStatsRank } from '@/types/panel-vm'

export type ApiKeyItem = {
  id: string
  name?: string
  /** 旧字段别名。列表请用 `key_prefix` / `maskApiKeyItem()`。 */
  prefix?: string
  key_prefix?: string
  key_suffix?: string
  /**
   * 列表接口返回掩码（含 `…`）。明文只出现在 create / reveal / rotate 的一次性响应里，
   * 不得渲染到列表、title、toast、console。
   */
  key?: string
  revealable?: boolean
  status?: string
  category?: 'oauth' | 'api'
  max_concurrency?: number
  quota_requests?: number
  quota_used?: number
  quota_usd?: number
  quota_usd_used?: number
  rpm?: number
  secret_status?: 'available' | 'hash_only' | 'decrypt_failed'
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  last_used_at?: string
  requests?: number
  inflight?: number
  user_id?: string | null
  /** 创建这把 Key 的面板用户；主密钥或迁移 064 之前创建的为 null */
  created_by_user_id?: string | null
  /** 仅用户角色的列表返回：管理员替你创建的 Key，只能改名称与 IP 名单 */
  managed_by_admin?: boolean
  group_id?: number | null
  group_name?: string | null
  rate_limit_5h?: number
  rate_limit_1d?: number
  rate_limit_7d?: number
  ip_whitelist?: string[]
  ip_blacklist?: string[]
  peer_sharing?: PeerSharing
  /** Key 级上游客户端画像覆盖；null 继承通用设置 */
  codex_client_profile?: ClientProfileSelection | null
}

// CPR 互联只读协议（GET /v1/cpr/link）的 Key 级共享开关
export type PeerSharing = {
  enabled: boolean
  share_pool: boolean
  share_plans: boolean
  share_quota: boolean
}

export type ApiKeysPayload = {
  keys?: ApiKeyItem[]
}

export type KeyUsageStats = {
  days: number
  since: string | null
  history: VmUsageStatsDay[]
  models: VmUsageStatsRank[]
  vms: VmUsageStatsRank[]
}

export type KeyStatsPayload = {
  item?: ApiKeyItem
  usage_stats?: KeyUsageStats | null
}

/** Gateway Worker 上游客户端画像选择（与 Worker profile.go 字段一致）：预设或自定义 User-Agent。 */
export type ClientProfileSelection = {
  mode?: 'custom'
  client?: 'desktop' | 'cli'
  platform?: 'macos' | 'linux' | 'windows'
  versionMode?: 'latest' | 'fixed'
  versionLag?: number
  cliEntry?: '' | 'tui' | 'exec'
  codexVersion?: string
  desktopVersion?: string
  desktopBuild?: string
  originator?: string
  userAgent?: string
}

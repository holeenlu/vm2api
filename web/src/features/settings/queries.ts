import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { BackupsPayload, NotifyStatus } from '@/types/panel-routing'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export type ChangelogEntry = {
  version: string
  tag: string | null
  date: string | null
  heading: string
  title: string
  body: string
  bullets: string[]
  needs_wrap_cli_sync: boolean
}

export type ReleaseStatus = {
  current: string
  current_tag: string
  latest: string | null
  latest_tag: string | null
  update_available: boolean | null
  check_status: 'ok' | 'failed' | 'not_checked'
  html_url: string
  published_at: string | null
  name: string | null
  notes: string
  changelog: ChangelogEntry[]
  needs_wrap_cli_sync: boolean
  upgrade_command: string
  check_command: string
  repo: string
  source_error?: string | null
  started?: boolean
  target?: string
  command?: string
  message?: string
  upgrade?: {
    state: 'running' | 'succeeded' | 'failed'
    target: string
    exit_code: number | null
    log_command: string
    phase?: string | null
    progress?: number | null
    message?: string | null
    updated_at?: string | null
  }
}

export type ChangelogPayload = {
  current: string
  current_tag: string
  entries: ChangelogEntry[]
}

export function routingQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.routing(),
    queryFn: () => api<Record<string, unknown>>('/api/panel/routing'),
  })
}

export function notifyQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.notify(),
    queryFn: () => api<NotifyStatus>('/api/panel/notify'),
  })
}

export function backupsQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.backups(),
    queryFn: () => api<BackupsPayload>('/api/panel/backups'),
  })
}

export function backupConfigQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.backupsConfig(),
    queryFn: () => api<Record<string, unknown>>('/api/panel/backups/config'),
  })
}

export function versionQueryOptions(upgradeTarget: string | null = null) {
  return queryOptions({
    queryKey: panelQueryKeys.version(),
    queryFn: ({ signal }) =>
      api<ReleaseStatus>('/api/panel/version?status=1', {
        cache: 'no-store',
        signal,
      }),
    // Only a user-requested upgrade polls. Mount/focus/reconnect and cache
    // invalidation must not initiate a release check in an idle console.
    enabled: (query) =>
      !!upgradeTarget || query.state.data?.upgrade?.state === 'running',
    refetchInterval: (query) =>
      upgradeTarget || query.state.data?.upgrade?.state === 'running'
        ? 2000
        : false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

export async function refreshVersionStatus(client: QueryClient) {
  const options = versionQueryOptions()
  // Cancel background status reads so an older response cannot replace this check.
  await client.cancelQueries({ queryKey: options.queryKey })
  return client.fetchQuery({
    ...options,
    queryFn: ({ signal }) =>
      api<ReleaseStatus>('/api/panel/version?force=1', {
        cache: 'no-store',
        signal,
      }),
    staleTime: 0,
  })
}

export function changelogQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.changelog(),
    queryFn: () => api<ChangelogPayload>('/api/panel/changelog'),
    staleTime: 60_000,
  })
}

export type HealthSnapshotView = {
  ok: boolean
  at: string | null
  stale: boolean
  vm_id: string | null
  model: string | null
  error: string | null
  age_ms: number | null
}

export type HealthProbePayload = {
  config: Record<string, unknown>
  snapshot: HealthSnapshotView | null
  snapshots: {
    anthropic: HealthSnapshotView
    openai: HealthSnapshotView
  } | null
}

export function healthProbeQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.healthProbe(),
    queryFn: () => api<HealthProbePayload>('/api/panel/health-probe'),
    refetchInterval: 30_000,
  })
}

/** `GET /api/panel/outbound-profile` → `src/lib/admin/outbound-profile.mjs`. */
export type OutboundProfile = {
  preset: string
  cli_version: string
  user_agent: string
  cc_entrypoint: string
  anthropic_beta: string
  beta_sample_model: string
}

export function outboundProfileQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.outboundProfile(),
    queryFn: () =>
      api<{ profile: OutboundProfile }>('/api/panel/outbound-profile'),
  })
}

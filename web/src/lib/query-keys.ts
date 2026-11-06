/** Canonical React Query keys for panel resources. */
export const panelQueryKeys = {
  root: () => ['panel'] as const,
  apiEndpoints: () => ['panel', 'api-endpoints'] as const,
  apiKeys: (scope: 'all' | 'mine' = 'all') =>
    ['panel', 'api-keys', scope] as const,
  apiKeyStats: (id: string) => ['panel', 'api-keys', id, 'stats'] as const,
  dashboard: () => ['panel', 'dashboard'] as const,
  usage: () => ['panel', 'usage'] as const,
  vms: () => ['panel', 'vms'] as const,
  vm: (id?: string) =>
    id ? (['panel', 'vm', id] as const) : (['panel', 'vm'] as const),
  vmCreateOptions: () => ['panel', 'vms', 'create-options'] as const,
  vmSeed: (id: string) => ['panel', 'vm', id, 'seed'] as const,
  vmSeedUploadLog: (id: string) =>
    ['panel', 'vm', id, 'seed-upload-log'] as const,
  vmCredential: (id: string) => ['panel', 'vm', id, 'credential'] as const,
  vmSetupTokenSession: (id: string) =>
    ['panel', 'vm', id, 'setup-token-session'] as const,
  vmOfficialCc: (id: string) => ['panel', 'vm', id, 'official-cc'] as const,
  officialCcBootstrap: (id: string) =>
    ['panel', 'official-cc-bootstrap', id] as const,
  testModels: (id = '') => ['panel', 'test-models', id] as const,
  requestLog: (id: string) => ['panel', 'request-log', id] as const,
  requestLogStats: (bucket: string, since: string, scope?: 'mine') =>
    ['panel', 'request-logs-stats', bucket, since, scope] as const,
  proxies: (vendorId?: string, platform?: string) =>
    vendorId || platform
      ? (['panel', 'proxies', vendorId || '', platform || ''] as const)
      : (['panel', 'proxies'] as const),
  requestLogs: () => ['panel', 'request-logs'] as const,
  usageLogs: () => ['panel', 'usage-logs'] as const,
  usageLogsBatch: (...parts: unknown[]) =>
    ['panel', 'usage-logs', 'batch', ...parts] as const,
  usageLogsSummary: (...parts: unknown[]) =>
    ['panel', 'usage-logs', 'summary', ...parts] as const,
  usageLogsFilterOptions: (...parts: unknown[]) =>
    ['panel', 'usage-logs', 'filter-options', ...parts] as const,
  usageLogsOverview: (...parts: unknown[]) =>
    ['panel', 'usage-logs', 'overview', ...parts] as const,
  vendor: (scope?: string) =>
    scope ? (['vendor', scope] as const) : (['vendor'] as const),
  vendorResource: (resourcePath: string, scope = '') =>
    ['vendor', resourcePath, scope] as const,
  supplierAdmin: (scope?: string) =>
    scope
      ? (['supplier-admin', scope] as const)
      : (['supplier-admin'] as const),
  me: () => ['panel', 'me'] as const,
  profile: () => ['panel', 'profile'] as const,
  users: () => ['panel', 'users'] as const,
  groups: () => ['panel', 'groups'] as const,
  groupOverrides: (id: number | string) =>
    ['panel', 'groups', id, 'overrides'] as const,
  groupsAvailableTo: (userId: string) =>
    ['panel', 'groups', 'available_to', userId] as const,
  billing: (scope = 'self', ...parts: unknown[]) =>
    ['panel', 'billing', scope, ...parts] as const,
  wallet: (id?: string) => ['panel', 'wallet', id] as const,
  subscriptions: () => ['panel', 'subscriptions'] as const,
  modelPolicy: (platform?: string) =>
    platform
      ? (['panel', 'model-policy', platform] as const)
      : (['panel', 'model-policy'] as const),
  models: () => ['panel', 'models'] as const,
  pricing: () => ['panel', 'pricing'] as const,
  riskFeed: (since?: string) =>
    since
      ? (['panel', 'risk-feed', since] as const)
      : (['panel', 'risk-feed'] as const),
  protocolEntry: () => ['panel', 'protocol-entry'] as const,
  distill: () => ['panel', 'distill'] as const,
  refusalGuards: () => ['panel', 'refusal-guards'] as const,
  jevIntercept: () => ['panel', 'jev-intercept'] as const,
  jevUsage: () => ['panel', 'jev-usage'] as const,
  databaseMetrics: () => ['panel', 'database-metrics'] as const,
  routing: () => ['panel', 'routing'] as const,
  notify: () => ['panel', 'notify'] as const,
  backups: () => ['panel', 'backups'] as const,
  backupsConfig: () => ['panel', 'backups-config'] as const,
  version: () => ['panel', 'version'] as const,
  changelog: () => ['panel', 'changelog'] as const,
  healthProbe: () => ['panel', 'health-probe'] as const,
  usageProbe: () => ['panel', 'usage-probe'] as const,
  outboundProfile: () => ['panel', 'outbound-profile'] as const,
  personaPreviewVars: (timezone: string) =>
    ['panel', 'persona', 'preview-vars', timezone] as const,
  kernels: () => ['panel', 'kernels'] as const,
  statsOverview: (tz: string) => ['panel', 'usage-logs-overview', tz] as const,
  stats: () => ['panel', 'statistics'] as const,
  statsChart: (range: string, dimension: string, tz: string) =>
    ['panel', 'statistics', 'chart', range, dimension, tz] as const,
  statsLeaderboard: (...parts: unknown[]) =>
    ['panel', 'statistics', 'leaderboard', ...parts] as const,
  activeSessions: (...parts: unknown[]) =>
    ['panel', 'usage-logs-active-sessions', ...parts] as const,
  siteBranding: () => ['site', 'branding'] as const,
  vendorBilling: (id?: string) =>
    id
      ? (['vendor', 'billing', id] as const)
      : (['vendor', 'billing'] as const),
  vendorUsage: (...parts: unknown[]) => ['vendor', 'usage', ...parts] as const,
  vendorMe: () => ['vendor', 'me'] as const,
  vendorAccounts: (...parts: unknown[]) =>
    ['vendor', 'accounts', ...parts] as const,
  vendorProxies: (...parts: unknown[]) =>
    ['vendor', 'proxies', ...parts] as const,
  vendorAccount: (...parts: unknown[]) => ['vendor', ...parts] as const,
  testScheduleDefault: () => ['panel', 'test-schedule', 'default'] as const,
  vmPackage: (id: string) => ['panel', 'vm-package', id] as const,
  vmDiagnose: (id: string) => ['panel', 'vm', id, 'diagnose'] as const,
  vmMigration: (id: string) => ['panel', 'slot-migration', id] as const,
  apiKeyConnection: (id: string) =>
    ['panel', 'api-keys', id, 'connection'] as const,
  apiKeyCodexCatalog: (id: string, base: string) =>
    ['panel', 'api-keys', id, 'codex-catalog', base] as const,
  clusterDocker: (id: string) => ['panel', 'cluster', id, 'docker'] as const,
  clusterDockerInfo: (id: string) =>
    ['panel', 'cluster', id, 'docker', 'info'] as const,
  clusterContainers: (id: string) =>
    ['panel', 'cluster', id, 'docker', 'containers'] as const,
  clusterLogs: (base: string, id: string) =>
    ['panel', 'cluster', base, 'logs', id] as const,
  clusterNode: (id: string) => ['panel', 'cluster', id] as const,
  clusterNodes: () => ['panel', 'cluster', 'nodes'] as const,
  clusterLocal: () => ['panel', 'cluster', 'local'] as const,
  clusterPreflight: (
    id: string,
    kernel: string,
    runtime: string,
    memory?: string
  ) =>
    [
      'panel',
      'cluster',
      id,
      'preflight',
      kernel,
      runtime,
      memory || null,
    ] as const,
  clusterSlotImage: (id: string, kernel: string) =>
    ['panel', 'cluster', id, 'slot-image', kernel] as const,
  supplierList: () => ['supplier-admin', 'suppliers'] as const,
} as const

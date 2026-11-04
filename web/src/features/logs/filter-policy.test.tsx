import { i18n } from '@/i18n'
import type { PanelRole } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { filtersForRole } from './filter-policy'
import { UsageLogsFilters } from './filters/usage-logs-filters'
import {
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  usageLogFiltersQuery,
  validateLogsSearch,
} from './search'

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data: options.queryKey.includes('session-suggestions')
      ? []
      : {
          users: [],
          keys: [],
          groups: [],
          models: [],
          vms: [],
          accounts: [],
          statusCodes: [],
        },
  }),
  queryOptions: (v: unknown) => v,
}))
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
const filters = {
  userId: 'u',
  keyId: 'k',
  groupId: '2',
  model: 'm',
  vmId: 'vm-private',
  accountId: 'account-private',
  sessionId: 'session-private',
  mismatch: true,
  minRetry: 2,
  debugOnly: true,
}
const diagnostic = [
  'vm_id',
  'account_id',
  'session_id',
  'model_mismatch',
  'min_attempt_count',
  'log_mode',
]
it.each(['admin', 'user', undefined] as const)(
  'strips privileged deep links before requests for %s',
  (role) => {
    const parsed = searchToFilters(validateLogsSearch(filtersToSearch(filters)))
    const safe = filtersForRole(parsed, role)
    const query = usageLogFiltersQuery(filtersToApi(safe, []))
    for (const key of diagnostic) expect(query.has(key)).toBe(false)
    expect(query.get('user_id')).toBe(role === 'admin' ? 'u' : null)
    expect(query.get('key_id')).toBe('k')
    expect(query.get('group_id')).toBe('2')
    expect(filtersToSearch(safe).sessionId).toBeUndefined()
  }
)
it('preserves all supported diagnostics for super admin and personal scope on reset', () => {
  const query = usageLogFiltersQuery(
    filtersToApi(filtersForRole(filters, 'super_admin'), [])
  )
  for (const key of diagnostic) expect(query.has(key)).toBe(true)
  const personal = filtersForRole({ ...filters, scope: 'mine' }, 'admin')
  expect(personal.scope).toBe('mine')
  expect(personal.userId).toBeUndefined()
})
it.each(['super_admin', 'admin', 'user', undefined] as const)(
  'renders role-appropriate controls and chips for %s',
  (role: PanelRole | undefined) => {
    const html = renderToStaticMarkup(
      <UsageLogsFilters
        role={role}
        filters={filtersForRole(filters, role)}
        onApply={() => {}}
        onReset={() => {}}
      />
    )
    for (const name of ['API 密钥', '分组', '模型', '状态码', '日期范围'])
      expect(html).toContain(name)
    for (const name of ['上游账号', 'Session ID', 'Debug', '重试次数'])
      expect(html.includes(name)).toBe(role === 'super_admin')
    expect(html.includes('aria-label="用户"')).toBe(
      role === 'super_admin' || role === 'admin'
    )
    if (role !== 'super_admin')
      for (const secret of ['vm-private', 'account-private', 'session-private'])
        expect(html).not.toContain(secret)
    expect(html).not.toContain('活跃 Session')
  }
)

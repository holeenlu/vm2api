import { i18n } from '@/i18n'
import type { PanelRole } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { filtersForRole } from './filter-policy'
import { withPlatform } from './filters/platform'
import { UsageLogsFilters } from './filters/usage-logs-filters'
import {
  filtersToApi,
  filtersToSearch,
  searchToFilters,
  usageLogFiltersQuery,
  validateLogsSearch,
} from './search'

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
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
  minRetry: 2,
}
const diagnostic = ['vm_id', 'account_id', 'session_id', 'min_attempt_count']
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
    for (const name of [
      'API 密钥',
      '分组',
      '平台',
      '模型',
      '状态码',
      '日期范围',
    ])
      expect(html).toContain(name)
    // Session ID 只剩深链筛选的已激活标签，表单不再提供输入框
    for (const name of ['上游账号', 'Session ID', '重试次数'])
      expect(html.includes(name)).toBe(role === 'super_admin')
    expect(html).not.toContain('搜索 Session ID')
    for (const removed of ['Debug', '上游模型审计', '端点', '全部协议'])
      expect(html).not.toContain(removed)
    expect(html.includes('aria-label="用户"')).toBe(
      role === 'super_admin' || role === 'admin'
    )
    if (role !== 'super_admin')
      for (const secret of ['vm-private', 'account-private', 'session-private'])
        expect(html).not.toContain(secret)
    expect(html).not.toContain('活跃 Session')
  }
)
it('switching platform drops accounts and models known to belong elsewhere', () => {
  const options = {
    users: [],
    keys: [],
    groups: [],
    vms: [],
    statusCodes: [],
    accounts: [
      { id: 'ek_oa', name: 'OpenAI API Key', platform: 'openai' as const },
      { id: 'acc-cl', name: 'claude-1', platform: 'anthropic' as const },
    ],
    models: [
      { id: 'gpt-6-astra', platform: 'openai' as const },
      { id: 'claude-opus-5-5', platform: 'anthropic' as const },
    ],
  }
  expect(
    withPlatform(
      { accountId: 'acc-cl', model: 'claude-opus-5-5' },
      'openai',
      options
    )
  ).toEqual({ platform: 'openai', accountId: undefined, model: undefined })
  expect(
    withPlatform(
      { accountId: 'ek_oa', model: 'gpt-6-astra' },
      'openai',
      options
    )
  ).toEqual({ platform: 'openai', accountId: 'ek_oa', model: 'gpt-6-astra' })
  // 深链带来的未知值不在选项里，保留交给后端判定
  expect(withPlatform({ model: 'legacy' }, 'anthropic', options).model).toBe(
    'legacy'
  )
  expect(
    withPlatform({ accountId: 'acc-cl' }, undefined, options).accountId
  ).toBe('acc-cl')
})

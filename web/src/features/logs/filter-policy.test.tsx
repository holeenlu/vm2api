import { i18n } from '@/i18n'
import type { PanelRole } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { filtersForRole } from './filter-policy'
import { reconcileFilters, scopeFilterOptions } from './filters/linkage'
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
  mismatch: true,
  minRetry: 2,
}
const diagnostic = [
  'vm_id',
  'account_id',
  'session_id',
  'model_mismatch',
  'min_attempt_count',
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
    for (const name of ['上游账号', 'Session ID', '重试次数', '上游模型审计'])
      expect(html.includes(name)).toBe(role === 'super_admin')
    expect(html).not.toContain('搜索 Session ID')
    for (const removed of ['Debug', '全部端点', '全部协议'])
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
const linkageOptions = {
  users: [],
  keys: [],
  statusCodes: [],
  groups: [
    {
      id: '3',
      name: 'Claude · API',
      platform: 'anthropic' as const,
      models: ['claude-opus-5-5'],
    },
    { id: '2', name: 'OpenAI', platform: 'openai' as const, models: [] },
    { id: '1', name: 'KDAN', platform: 'mixed' as const, models: [] },
  ],
  accounts: [
    {
      id: 'ek_oa',
      name: 'OpenAI API Key',
      platform: 'openai' as const,
      groupIds: ['2', '1'],
    },
    {
      id: 'acc-cl',
      name: 'claude-1',
      platform: 'anthropic' as const,
      groupIds: ['3', '1'],
    },
    {
      id: 'acc-cl2',
      name: 'claude-2',
      platform: 'anthropic' as const,
      groupIds: ['1'],
    },
  ],
  vms: [
    {
      id: 'vm-cl',
      name: 'Slot C',
      platform: 'anthropic' as const,
      groupIds: ['3'],
    },
    {
      id: 'vm-cx',
      name: 'Slot X',
      platform: 'openai' as const,
      groupIds: ['2'],
    },
  ],
  models: [
    { id: 'gpt-6-astra', platform: 'openai' as const },
    { id: 'claude-opus-5-5', platform: 'anthropic' as const },
    { id: 'claude-haiku-5-5', platform: 'anthropic' as const },
    { id: 'mystery', platform: null },
  ],
}
const ids = (list: { id: string }[] | string[]) =>
  list.map((item) => (typeof item === 'string' ? item : item.id))

it('platform scopes groups (incl. mixed), models, accounts and slots', () => {
  const scoped = scopeFilterOptions({ platform: 'anthropic' }, linkageOptions)
  expect(ids(scoped.groups)).toEqual(['3', '1'])
  expect(scoped.models).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  expect(ids(scoped.accounts)).toEqual(['acc-cl', 'acc-cl2'])
  expect(ids(scoped.vms)).toEqual(['vm-cl'])
})

it('group scopes models by whitelist (else by platform), accounts and slots', () => {
  const claude = scopeFilterOptions({ groupId: '3' }, linkageOptions)
  expect(claude.models).toEqual(['claude-opus-5-5'])
  expect(ids(claude.accounts)).toEqual(['acc-cl'])
  expect(ids(claude.vms)).toEqual(['vm-cl'])
  const openai = scopeFilterOptions({ groupId: '2' }, linkageOptions)
  expect(openai.models).toEqual(['gpt-6-astra'])
  // mixed 分组不设白名单：模型不限平台，账号按分组资源
  const mixed = scopeFilterOptions({ groupId: '1' }, linkageOptions)
  expect(mixed.models).toEqual(ids(linkageOptions.models))
  expect(ids(mixed.accounts)).toEqual(['ek_oa', 'acc-cl', 'acc-cl2'])
  // 平台与分组叠加
  const both = scopeFilterOptions(
    { groupId: '1', platform: 'openai' },
    linkageOptions
  )
  expect(both.models).toEqual(['gpt-6-astra'])
  expect(ids(both.accounts)).toEqual(['ek_oa'])
})

it('changing platform or group clears selections that fall out of scope', () => {
  expect(
    reconcileFilters(
      {
        platform: 'openai',
        groupId: '3',
        model: 'claude-opus-5-5',
        accountId: 'acc-cl',
        vmId: 'vm-cl',
      },
      linkageOptions
    )
  ).toEqual({
    platform: 'openai',
    groupId: undefined,
    model: undefined,
    accountId: undefined,
    vmId: undefined,
  })
  expect(
    reconcileFilters(
      { groupId: '3', model: 'claude-haiku-5-5', accountId: 'acc-cl2' },
      linkageOptions
    )
  ).toEqual({ groupId: '3', model: undefined, accountId: undefined })
  expect(
    reconcileFilters(
      { groupId: '1', platform: 'anthropic', accountId: 'acc-cl2' },
      linkageOptions
    ).accountId
  ).toBe('acc-cl2')
  // 深链带来的未知值不在选项里，保留交给后端
  expect(
    reconcileFilters({ platform: 'anthropic', model: 'legacy' }, linkageOptions)
      .model
  ).toBe('legacy')
})

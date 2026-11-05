import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import { i18n, t } from '@/i18n'
import type { MeResponse } from '@/types/panel-auth'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { panelQueryKeys } from '@/lib/query-keys'
import { meQueryOptions } from '@/features/auth/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import {
  VmActionsContext,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { VmDetailCardBody } from '@/features/vm/vm-detail-card'
import { AccountDetailBody } from './account-detail-page'
import {
  accountBase,
  accountQueryKey,
  gatewayAccountAsVm,
  type GatewayAccount,
} from './accounts-model'

const account: GatewayAccount = {
  id: 'acc-1',
  name: 'Team A',
  vendor_id: null,
  status: 'active',
  config: {
    email: 'a@example.test',
    group_ids: [3],
    proxy_id: 'px-1',
    proxy_endpoint: 'socks5://proxy.example.test:1080',
    notes: 'night shift',
  },
  runtime_account_id: 'runtime-internal-1',
  credential_revision: 2,
  projection_status: 'synced',
}

const pool = [
  {
    id: 'px-1',
    host: 'proxy.example.test',
    port: 1080,
    label: 'HK-1',
    status: 'ok',
    latency_ms: 154,
  },
]

const noop = () => {}
const baseActions: VmActions = {
  openDetail: noop,
  openTest: noop,
  openStats: noop,
  openReauth: noop,
  refreshToken: noop,
  recover: noop,
  refreshingId: null,
  recoveringId: null,
}

async function render(node: ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient()
  queryClient.setQueryData<MeResponse>(meQueryOptions().queryKey, {
    user: 'demo',
    role: 'super_admin',
    views: [],
    resource_permissions: [
      'resources.read',
      'resources.create',
      'resources.edit',
      'resources.manage',
    ],
    vendor: null,
  })
  seed?.(queryClient)
  const root = createRootRoute()
  const router = createRouter({
    routeTree: root.addChildren(
      ['/vm/$id', '/codex-accounts', '/codex-accounts/$id'].map((path) =>
        createRoute({ getParentRoute: () => root, path })
      )
    ),
    history: createMemoryHistory({ initialEntries: ['/codex-accounts'] }),
  })
  await router.load()
  await i18n.changeLanguage('zh-CN')
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </RouterContextProvider>
    </QueryClientProvider>
  )
}

describe('VmDetailCardBody', () => {
  it('links Gateway accounts to the Codex account page and skips slot-only blocks', async () => {
    const vm = gatewayAccountAsVm(account, new Map([[3, 'Codex']]), pool)
    const html = await render(
      <VmActionsContext.Provider
        value={{
          ...baseActions,
          detailRoute: '/codex-accounts/$id',
          openEdit: noop,
        }}
      >
        <VmDetailCardBody vm={vm} />
      </VmActionsContext.Provider>
    )
    expect(html).toContain('href="/codex-accounts/acc-1"')
    expect(html).toContain('编辑账号')
    // 与 VM 相同的代理芯片：池内代理的健康底色与延迟
    expect(html).toContain('bg-ok-1')
    expect(html).toContain('>154<')
    expect(html).not.toContain(
      t('vm:vmScheduling.allSettingsFollowGlobalDefaults')
    )
  })

  it('keeps the VM detail link for regular slots', async () => {
    const vm = { id: 'vm-1', name: 'slot', platform: 'anthropic' } as Vm
    const html = await render(
      <VmActionsContext.Provider value={baseActions}>
        <VmDetailCardBody vm={vm} />
      </VmActionsContext.Provider>
    )
    expect(html).toContain('href="/vm/vm-1"')
    expect(html).not.toContain('编辑账号')
  })
})

describe('AccountDetailBody', () => {
  it('renders the VM-style header and overview without the internal runtime account id', async () => {
    const html = await render(
      <AccountDetailBody id='acc-1' tab='overview' onTabChange={noop} />,
      (qc) => {
        qc.setQueryData([...accountQueryKey, 'acc-1', 'detail'], { account })
        qc.setQueryData(proxiesQueryOptions().queryKey, { proxies: pool })
        qc.setQueryData(
          panelQueryKeys.vendorAccount(accountBase, 'account-usage', 'acc-1', {
            range: 'all',
            start_date: '',
            end_date: '',
          }),
          {
            models: [
              {
                model: 'gpt-5-codex',
                requests: 3,
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                unpriced_requests: 0,
                cost_usd: 0.5,
              },
            ],
          }
        )
      }
    )
    expect(html).toContain('href="/codex-accounts"')
    expect(html).toContain(t('vm:runtimeChip.gateway'))
    expect(html).toContain(t('vm:detailPage.overview'))
    expect(html).toContain(t('vm:detailPage.operations'))
    // 概览复用 VM 详情页的状态板与计费窗口，「运行」栏换成 Worker 字段
    expect(html).toContain(t('vm:detailStatusBoard.currentState'))
    expect(html).toContain(t('vm:detailOverviewTab.billingWindows'))
    expect(html).toContain(t('common:codexWorkerSync'))
    expect(html).not.toContain(
      t('vm:vmScheduling.allSettingsFollowGlobalDefaults')
    )
    expect(html).toContain('HK-1')
    expect(html).toContain('gpt-5-codex')
    expect(html).not.toContain('runtime-internal-1')
  })

  it('proxy tab probes pooled exits and offers to pool a pasted inline proxy', async () => {
    const seed = (value: GatewayAccount) => (qc: QueryClient) => {
      qc.setQueryData([...accountQueryKey, 'acc-1', 'detail'], {
        account: value,
      })
      qc.setQueryData(proxiesQueryOptions().queryKey, { proxies: pool })
    }
    const pooled = await render(
      <AccountDetailBody id='acc-1' tab='proxy' onTabChange={noop} />,
      seed(account)
    )
    expect(pooled).toContain(t('common:codexProxyDescription'))
    expect(pooled).toContain(t('vm:detailProxyTab.checkConnection'))
    expect(pooled).toContain('154ms')
    expect(pooled).not.toContain(`>${t('vm:detailProxyTab.unbind')}<`)
    expect(pooled).not.toContain(t('common:codexPoolProxy'))

    const inline = await render(
      <AccountDetailBody id='acc-1' tab='proxy' onTabChange={noop} />,
      seed({
        ...account,
        config: {
          ...account.config,
          proxy_id: '',
          proxy_endpoint: 'socks5h://204.1.67.230:6949',
        },
      })
    )
    expect(inline).toContain('204.1.67.230:6949')
    // 池外地址不知道是否带账密，认证显示「—」而不是「无」
    expect(inline).not.toContain(`>${t('vm:detailProxyTab.none')}<`)
    expect(inline).toContain(t('common:codexProxyNotPooled'))
    expect(inline).toContain(t('common:codexPoolProxy'))
    expect(inline).not.toContain(`>${t('vm:detailProxyTab.checkConnection')}<`)
  })
})

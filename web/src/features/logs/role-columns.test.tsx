import { i18n } from '@/i18n'
import type { PanelRole } from '@/types/panel-auth'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { canShowLogColumn, LOGS_TABLE_COLUMNS } from './column-visibility'
import { ColumnVisibilityDropdown } from './column-visibility-dropdown'
import { ModelDisplayWithRedirect } from './log-cells'
import { LogsFullscreen } from './logs-fullscreen'
import { VirtualizedLogsTable } from './virtualized-logs-table'

const { row } = vi.hoisted(() => ({
  row: {
    id: 'log-role-check',
    createdAt: '2026-10-31T10:00:00Z',
    userName: 'Example',
    keyName: 'Example key',
    sessionId: 'outbound-secret-session',
    vmName: 'private-upstream-slot',
    providerChain: [],
    model: 'example-model',
    originalModel: 'gpt-6-astra',
    actualResponseModel: 'gpt-5.6-luna',
    statusCode: 200,
    inputTokens: 12,
    outputTokens: 6,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    durationMs: 1000,
  } as unknown as UsageLogRow,
}))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useInfiniteQuery: () => ({
    data: { pages: [{ logs: [row] }] },
    hasNextPage: false,
  }),
  useQuery: () => ({ data: undefined }),
}))
vi.mock('@/hooks/use-virtualized-infinite-list', () => ({
  useVirtualizedInfiniteList: () => ({
    parentRef: { current: null },
    rowVirtualizer: { getTotalSize: () => 52 },
    virtualItems: [{ index: 0, start: 0, size: 52 }],
    showScrollToTop: false,
    handleScroll: () => {},
    scrollToTop: () => {},
    resetScrollPosition: () => {},
  }),
}))
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
const noop = () => {}
function render(
  role: PanelRole | undefined,
  fullscreen: boolean,
  hidden: ('sessionId' | 'provider')[] = []
) {
  return renderToStaticMarkup(
    <TooltipProvider>
      {fullscreen ? (
        <LogsFullscreen
          role={role}
          title='使用记录'
          filters={{}}
          onOpenDetail={noop}
          onExit={noop}
        />
      ) : (
        <VirtualizedLogsTable
          role={role}
          filters={{}}
          autoRefreshEnabled={false}
          hiddenColumns={hidden}
          onOpenDetail={noop}
        />
      )}
    </TooltipProvider>
  )
}

describe('usage log role columns', () => {
  for (const fullscreen of [false, true]) {
    it.each(['admin', 'user', 'vendor', undefined] as const)(
      `hides headers and row values for %s (fullscreen=${fullscreen})`,
      (role) => {
        const html = render(role, fullscreen)
        expect(html).not.toContain('活跃 Session')
        for (const text of [
          '出站 Session',
          '供应商',
          'outbound-secret-session',
          'private-upstream-slot',
          'gpt-5.6-luna',
          '上游响应',
          '模型不一致',
        ])
          expect(html).not.toContain(text)
        expect(html).toContain('example-model')
      }
    )
    it(`keeps original columns for super admin (fullscreen=${fullscreen})`, () => {
      const html = render('super_admin', fullscreen)
      expect(html).not.toContain('活跃 Session')
      expect(html).toContain('gpt-6-astra')
      expect(html).toContain('上游响应：gpt-5.6-luna')
      expect(html).toContain('模型不一致')
      expect(html).not.toContain('>example-model<')
      for (const text of [
        '出站 Session',
        '供应商',
        'outbound-secret-session',
        'private-upstream-slot',
      ])
        expect(html).toContain(text)
    })
  }
  it('retains super admin column preferences', () => {
    const html = render('super_admin', false, ['sessionId', 'provider'])
    expect(html).not.toContain('outbound-secret-session')
    expect(html).not.toContain('private-upstream-slot')
  })
  it.each(['super_admin', 'admin', 'user', undefined] as const)(
    'menu counts only role-available columns for %s',
    (role) => {
      const columns = LOGS_TABLE_COLUMNS.filter((c) =>
        canShowLogColumn(c.id, role)
      )
      expect(columns.some((c) => c.id === 'sessionId')).toBe(
        role === 'super_admin'
      )
      expect(columns.some((c) => c.id === 'provider')).toBe(
        role === 'super_admin'
      )
      const html = renderToStaticMarkup(
        <ColumnVisibilityDropdown
          role={role}
          hidden={['sessionId', 'provider']}
          onChange={noop}
        />
      )
      const visible = columns.filter(
        (c) => c.id !== 'sessionId' && c.id !== 'provider'
      ).length
      expect(html).toContain(`${visible}/${columns.length}`)
    }
  )
})

describe('super admin model response display', () => {
  it.each([
    ['same', 'gpt-6-astra', 'gpt-6-astra', false],
    ['different', 'gpt-5.6-luna', 'gpt-5.6-luna', true],
    ['missing', null, '未记录', false],
    ['empty', '  ', '未记录', false],
  ])('%s response model', (_name, actual, label, mismatch) => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ModelDisplayWithRedirect
          role='super_admin'
          row={{ ...row, actualResponseModel: actual as string | null }}
          onRedirectClick={noop}
        />
      </TooltipProvider>
    )
    expect(html).toContain('gpt-6-astra')
    if (mismatch) expect(html).toContain(`上游响应：${label}`)
    else expect(html).not.toContain('上游响应')
    expect(html.includes('模型不一致')).toBe(mismatch)
  })
})

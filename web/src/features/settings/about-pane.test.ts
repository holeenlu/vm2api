import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { AboutPane } from './about-pane'
import {
  changelogQueryOptions,
  versionQueryOptions,
  type ReleaseStatus,
} from './queries'
import { VersionDetails } from './version-menu'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

function renderStatus(overrides: Partial<ReleaseStatus>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(versionQueryOptions().queryKey, {
    current: '1.3.179',
    current_tag: 'v1.3.179',
    latest: '1.3.179',
    latest_tag: 'v1.3.179',
    update_available: false,
    check_status: 'ok',
    html_url: '',
    published_at: null,
    name: null,
    notes: '',
    needs_wrap_cli_sync: false,
    upgrade_command: '',
    check_command: '',
    repo: 'holeenlu/vm2api',
    source_error: null,
    changelog: [],
    ...overrides,
  })
  client.setQueryData(changelogQueryOptions().queryKey, {
    current: '1.3.179',
    current_tag: 'v1.3.179',
    entries: [],
  })
  try {
    return renderToStaticMarkup(
      createElement(VersionDetails, {
        data: client.getQueryData<ReleaseStatus>(
          versionQueryOptions().queryKey
        ),
      })
    )
  } finally {
    client.clear()
  }
}

describe('release check display', () => {
  it('never labels a failed check as up to date (including older API responses)', () => {
    const html = renderStatus({ source_error: 'github_http_503' })
    expect(html).not.toContain('已是最新')
    expect(html).toContain('检查失败')
  })

  it('does not advertise a cached update or enable upgrade when refresh failed', () => {
    const html = renderStatus({
      source_error: 'offline',
      update_available: true,
      latest_tag: 'v1.3.180',
    })
    expect(html).not.toContain('有更新')
    expect(html).not.toContain('已是最新')
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*开始升级/
    )
  })

  it('continues to show successful up-to-date and newer-release results', () => {
    expect(renderStatus({})).toContain('已是最新')
    expect(
      renderStatus({ update_available: true, latest_tag: 'v1.3.180' })
    ).toContain('有更新')
  })
})

describe('about page after moving the update flow', () => {
  it('only renders the complete changelog and does not subscribe to version checks', () => {
    const client = new QueryClient()
    client.setQueryData(changelogQueryOptions().queryKey, {
      current: '1.4.028',
      current_tag: 'v1.4.028',
      entries: Array.from({ length: 10 }, (_, i) => ({
        version: `1.4.${28 - i}`,
        tag: `v1.4.${28 - i}`,
        date: null,
        heading: `release-${i}`,
        title: `release description ${i}`,
        body: '',
        bullets: [`fixed ${i}`],
        needs_wrap_cli_sync: false,
      })),
    })
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(AboutPane))
    )
    expect(html).toContain('更新日志')
    expect(html).toContain('fixed 9')
    expect(html).not.toContain('检查更新')
    expect(html).not.toContain('开始升级')
    expect(
      client.getQueryCache().find({ queryKey: versionQueryOptions().queryKey })
    ).toBeUndefined()
    client.clear()
  })
  it('shows progress and prevents another update while running', () => {
    const html = renderToStaticMarkup(
      createElement(VersionDetails, {
        currentVersion: 'v1.4.027',
        running: true,
        target: 'v1.4.028',
      })
    )
    expect(html).toContain('正在更新到 v1.4.028')
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*开始升级/
    )
  })
})

import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isRedirect,
  RouterContextProvider,
} from '@tanstack/react-router'
import { i18n } from '@/i18n'
import { Route as ConsoleRoute } from '@/routes/_authenticated/index'
import type { MeResponse } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meQueryOptions } from '@/features/auth/queries'
import { MarketingHome } from './marketing-home'

afterEach(() => vi.unstubAllGlobals())

describe('welcome console entry', () => {
  it.each([
    { role: null, views: [], destination: '/login' },
    {
      role: 'super_admin',
      views: ['overview', 'users'],
      destination: '/overview',
    },
    { role: 'admin', views: ['users', 'keys'], destination: '/users' },
    { role: 'user', views: ['keys', 'statistics'], destination: '/keys' },
    { role: 'vendor', views: [], destination: '/vendor' },
  ] as const)(
    'opens $destination for $role',
    async ({ role, views, destination }) => {
      vi.stubGlobal('localStorage', {
        getItem: () => (role ? 'demo-session' : null),
      })
      const queryClient = new QueryClient()
      queryClient.setQueryData<MeResponse>(meQueryOptions().queryKey, {
        user: 'demo',
        role: role || 'user',
        views: [...views],
        vendor:
          role === 'vendor'
            ? {
                name: 'Demo',
                role: 'vendor',
                tier: 1,
                views: ['accounts'],
                capabilities: [],
              }
            : null,
      })
      const root = createRootRouteWithContext<{ queryClient: QueryClient }>()(
        {}
      )
      const pages = [
        '/welcome',
        '/login',
        '/overview',
        '/users',
        '/keys',
        '/vendor',
      ].map((path) => createRoute({ getParentRoute: () => root, path }))
      const router = createRouter({
        routeTree: root.addChildren(pages),
        history: createMemoryHistory({ initialEntries: ['/welcome'] }),
        context: { queryClient },
      })
      await router.load()
      const html = renderToStaticMarkup(
        <RouterContextProvider router={router}>
          <I18nextProvider i18n={i18n}>
            <MarketingHome
              signedIn={Boolean(role)}
              baseUrl='https://example.test'
            />
          </I18nextProvider>
        </RouterContextProvider>
      )
      const entries = [
        ...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
      ]
        .filter(([, , content]) =>
          content.includes(
            i18n.t(role ? 'welcome:openConsole' : 'welcome:signInConsole')
          )
        )
        .map(([, href]) => href)
      expect(entries).toHaveLength(3)
      expect(entries).toEqual(Array(3).fill(role ? '/' : '/login'))
      if (role) {
        const result = await Promise.resolve()
          .then(() =>
            ConsoleRoute.options.beforeLoad!({
              context: { queryClient },
            } as never)
          )
          .catch((error: unknown) => error)
        expect(isRedirect(result)).toBe(true)
        if (isRedirect(result))
          expect(result.options.to || result.options.href).toBe(destination)
      }
      queryClient.clear()
    }
  )
})

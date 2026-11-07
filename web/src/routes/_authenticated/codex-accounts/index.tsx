import { createFileRoute } from '@tanstack/react-router'
import { prefetchResourceWorkbench } from '@/features/resources/queries'
import { ResourceWorkbench } from '@/features/resources/resource-workbench'

export const Route = createFileRoute('/_authenticated/codex-accounts/')({
  // 不等待：数据与路由代码、/me 并行加载，组件里的查询直接命中缓存。
  loader: ({ context }) => {
    prefetchResourceWorkbench(context.queryClient, 'codex')
  },
  component: function CodexAccountsRoute() {
    return <ResourceWorkbench preset='codex' />
  },
})

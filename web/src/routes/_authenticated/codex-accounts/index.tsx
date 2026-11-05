import { createFileRoute } from '@tanstack/react-router'
import { ResourceWorkbench } from '@/features/resources/resource-workbench'

export const Route = createFileRoute('/_authenticated/codex-accounts/')({
  component: function CodexAccountsRoute() {
    return <ResourceWorkbench preset='codex' />
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { CodexAccountsPage } from '@/features/gateway-worker'

export const Route = createFileRoute('/_authenticated/codex-accounts/')({
  component: CodexAccountsPage,
})

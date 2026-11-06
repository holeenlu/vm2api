import { createFileRoute } from '@tanstack/react-router'
import { CodexAccountDetailPage } from '@/features/gateway-worker/account-detail-page'

export const Route = createFileRoute('/_authenticated/codex-accounts/$id')({
  component: CodexAccountDetailPage,
})

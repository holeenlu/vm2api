import { createFileRoute } from '@tanstack/react-router'
import { GatewayWorkersPage } from '@/features/gateway-worker'

export const Route = createFileRoute('/_authenticated/gateway-workers')({
  component: GatewayWorkersPage,
})

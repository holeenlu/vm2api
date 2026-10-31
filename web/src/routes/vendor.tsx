import { createFileRoute, Outlet } from '@tanstack/react-router'
import { vendorRouteBeforeLoad } from '@/features/vendor'

export const Route = createFileRoute('/vendor')({
  beforeLoad: vendorRouteBeforeLoad,
  component: Outlet,
})

import { createFileRoute } from '@tanstack/react-router'
import { VendorPortalPage } from '@/features/vendor'

export const Route = createFileRoute('/vendor/$page')({
  component: VendorPortalPage,
})

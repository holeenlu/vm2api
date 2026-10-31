import { createFileRoute, redirect } from '@tanstack/react-router'
import { SupplierAdminPage } from '@/features/supplier-admin'
import { PAGES, type SupplierPage } from '@/features/supplier-admin/model'

export const Route = createFileRoute('/_authenticated/suppliers/$page')({
  validateSearch: (search: Record<string, unknown>) => ({
    vendor_id: typeof search.vendor_id === 'string' ? search.vendor_id : 'all',
  }),
  beforeLoad: ({ params }) => {
    if (!PAGES.includes(params.page as SupplierPage))
      throw redirect({
        to: '/suppliers/$page',
        params: { page: 'suppliers' },
        search: { vendor_id: 'all' },
      })
  },
  component: function SuppliersRoute() {
    const { page } = Route.useParams()
    const { vendor_id } = Route.useSearch()
    return (
      <SupplierAdminPage
        key={`${page}:${vendor_id}`}
        page={page as SupplierPage}
        initialVendor={vendor_id}
      />
    )
  },
})

import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/suppliers/')({
  beforeLoad: () => {
    throw redirect({
      to: '/suppliers/$page',
      params: { page: 'suppliers' },
      search: { vendor_id: 'all' },
    })
  },
})

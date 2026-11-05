import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/vendor/')({
  beforeLoad: () => {
    throw redirect({ to: '/vendor/$page', params: { page: 'accounts' } })
  },
})

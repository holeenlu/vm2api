import { createFileRoute } from '@tanstack/react-router'
import { GroupsPage } from '@/features/groups'

export const Route = createFileRoute('/_authenticated/groups')({
  component: GroupsPage,
})

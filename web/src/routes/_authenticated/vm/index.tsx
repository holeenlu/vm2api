import { createFileRoute } from '@tanstack/react-router'
import { ResourceWorkbench } from '@/features/resources/resource-workbench'

export const Route = createFileRoute('/_authenticated/vm/')({
  component: function VmRoute() {
    return <ResourceWorkbench preset='vm' />
  },
})

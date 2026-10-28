import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { OnboardFlow } from './onboard-flow'
import { VmPackageImportCard } from './vm-package-card'

export function ImportPage() {
  const { t } = useTranslation('import')

  const dash = useQuery(dashboardQueryOptions())
  const [tab, setTab] = useState('onboard')
  return (
    <PageHeader
      title={VIEW_TITLES.import}
      description={t('import:description')}
    >
      <Tabs value={tab} onValueChange={setTab} className='max-w-6xl gap-6'>
        <TabsList>
          <TabsTrigger value='onboard'>{t('import:onboard')}</TabsTrigger>
          <TabsTrigger value='package'>{t('import:importJson')}</TabsTrigger>
        </TabsList>
        <TabsContent value='onboard'>
          <QueryGate
            loading={dash.isLoading}
            error={dash.error}
            skeleton={
              <SectionSkeleton
                titleWidth='w-28'
                showDescription={false}
                rows={8}
              />
            }
          >
            <OnboardFlow />
          </QueryGate>
        </TabsContent>
        <TabsContent value='package' className='max-w-2xl'>
          <VmPackageImportCard />
        </TabsContent>
      </Tabs>
    </PageHeader>
  )
}

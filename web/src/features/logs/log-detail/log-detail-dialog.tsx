import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { FileCode2, FileText, Gauge, GitBranch, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { meQueryOptions } from '@/features/auth/queries'
import { StatusBadge } from '../log-cells'
import type { DetailTab } from '../virtualized-logs-table'
import { LogicTraceTab } from './logic-trace-tab'
import { PerformanceTab } from './performance-tab'
import { RawDataTab } from './raw-data-tab'
import { SummaryTab } from './summary-tab'

export type DetailState = {
  row: UsageLogRow
  tab?: DetailTab
  chainIndex?: number
  scrollToRedirect?: boolean
}

const TAB_TRIGGER =
  'flex items-center gap-1.5 px-2 py-1.5 text-xs data-[state=active]:bg-background sm:text-sm'
const TAB_ICON = 'h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4'

/** 请求详情弹窗：概览 / 决策链 / 性能 / 原始数据（debug 请求体与响应体）。 */
export function LogDetailDialog({
  state,
  onClose,
}: {
  state: DetailState | null
  onClose: () => void
}) {
  const { t: translate } = useTranslation('logs')

  const me = useQuery(meQueryOptions())
  const isStaff = me.data?.role === 'admin' || me.data?.role === 'super'
  const isAdmin = me.data?.role === 'admin'
  const [tab, setTab] = useState<DetailTab>('summary')
  useEffect(() => {
    if (!state) return
    setTab(state.scrollToRedirect ? 'summary' : (state.tab ?? 'summary'))
  }, [state])
  const row = state?.row

  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      {/* z-[90]: must sit above the fullscreen log view (z-[70]/z-[80]). */}
      <DialogPortal>
        <DialogOverlay className='z-[90]' />
        <DialogPrimitive.Content className='fixed top-1/2 left-1/2 z-[90] flex max-h-[90vh] w-[min(96vw,1100px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border bg-background shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'>
          <DialogPrimitive.Close className='absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden'>
            <XIcon className='size-4' />
            <span className='sr-only'>{translate('logs:close')}</span>
          </DialogPrimitive.Close>
          <DialogHeader className='border-b px-6 pt-5 pb-3'>
            <DialogTitle className='flex items-center gap-2'>
              {translate('logs:requestDetails')}
              {row ? (
                <StatusBadge
                  statusCode={row.statusCode}
                  finalState={row.finalState}
                  errorCode={row.errorCode}
                />
              ) : null}
            </DialogTitle>
            <DialogDescription className='font-mono text-xs break-all'>
              {row?.requestId || row?.id || '—'}
            </DialogDescription>
          </DialogHeader>
          {row ? (
            <Tabs
              key={row.id}
              value={
                (tab === 'raw' && !isAdmin) ||
                (tab === 'logic-trace' && !isStaff)
                  ? 'summary'
                  : tab
              }
              onValueChange={(value) => setTab(value as DetailTab)}
              className='flex min-h-0 flex-1 flex-col'
            >
              <div className='px-6 pt-3'>
                <TabsList className='grid h-auto w-full grid-cols-4 p-1'>
                  <TabsTrigger value='summary' className={TAB_TRIGGER}>
                    <FileText className={TAB_ICON} />
                    <span>{translate('logs:overview')}</span>
                  </TabsTrigger>
                  {isStaff && (
                    <TabsTrigger value='logic-trace' className={TAB_TRIGGER}>
                      <GitBranch className={TAB_ICON} />
                      <span>{translate('logs:decisionChain')}</span>
                    </TabsTrigger>
                  )}
                  <TabsTrigger value='performance' className={TAB_TRIGGER}>
                    <Gauge className={TAB_ICON} />
                    <span>{translate('logs:performance')}</span>
                  </TabsTrigger>
                  {isAdmin && (
                    <TabsTrigger value='raw' className={TAB_TRIGGER}>
                      <FileCode2 className={TAB_ICON} />
                      <span>{translate('logs:rawData')}</span>
                    </TabsTrigger>
                  )}
                </TabsList>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6'>
                <TabsContent value='summary' className='mt-0'>
                  <SummaryTab
                    row={row}
                    scrollToRedirect={!!state?.scrollToRedirect}
                  />
                </TabsContent>
                {isStaff && (
                  <TabsContent value='logic-trace' className='mt-0'>
                    <LogicTraceTab
                      row={row}
                      initialExpandedIndex={state?.chainIndex}
                    />
                  </TabsContent>
                )}
                <TabsContent value='performance' className='mt-0'>
                  <PerformanceTab row={row} />
                </TabsContent>
                {isAdmin && (
                  <TabsContent value='raw' className='mt-0'>
                    <RawDataTab
                      requestId={row.requestId}
                      logMode={row.logMode}
                    />
                  </TabsContent>
                )}
              </div>
            </Tabs>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

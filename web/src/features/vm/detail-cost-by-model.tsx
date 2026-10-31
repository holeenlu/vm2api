import { t as tVm } from '@/i18n'
import type { VmBillingModelRow } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { fmtNum, fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

/** 计费档位标签；标准档返回空数组。 */
function billingBandLabels(row: VmBillingModelRow): string[] {
  const out: string[] = []
  if (row.service_tier === 'fast') out.push('Fast')
  else if (row.service_tier === 'flex') out.push('Flex')
  else if (row.service_tier) out.push(row.service_tier)
  if (row.speed === 'fast') out.push('Fast mode')
  if (Number(row.long_context) === 1)
    out.push(tVm('vm:detailCostByModel.longContext'))
  return out
}

/** 按模型 × 计费档位的官方价费用拆分（累计）。 */
export function VmCostByModel({
  rows,
  compact = false,
}: {
  rows?: VmBillingModelRow[]
  /** 弹窗里与其它信息卡同一内边距；详情页 Tab 保持默认。 */
  compact?: boolean
}) {
  useTranslation('vm')

  if (!rows?.length) return null
  return (
    <Card className={compact ? 'gap-3 rounded-xl py-3.5' : undefined}>
      <CardHeader className={compact ? 'px-3.5' : undefined}>
        <CardTitle className='text-sm'>
          <Trans ns='vm' i18nKey='detailCostByModel.costByModel' />
        </CardTitle>
        <p className='text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='detailCostByModel.officialPricingCumulativeSplitByBillingTier'
          />
        </p>
      </CardHeader>
      <CardContent
        className={compact ? 'overflow-x-auto px-3.5' : 'overflow-x-auto'}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans ns='vm' i18nKey='detailCostByModel.model' />
              </TableHead>
              <TableHead>
                <Trans ns='vm' i18nKey='detailCostByModel.tier' />
              </TableHead>
              <TableHead className='text-right'>
                <Trans ns='vm' i18nKey='detailAccountTab.requests' />
              </TableHead>
              <TableHead className='text-right'>
                <Trans ns='vm' i18nKey='detailCostByModel.inputOutput' />
              </TableHead>
              <TableHead className='text-right'>
                <Trans ns='vm' i18nKey='detailCostByModel.cacheReadWrite' />
              </TableHead>
              <TableHead className='text-right'>
                <Trans ns='vm' i18nKey='detailCostByModel.cost' />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const labels = billingBandLabels(row)
              const unpriced = Number(row.unpriced_requests || 0)
              return (
                <TableRow
                  key={`${row.model}|${row.service_tier ?? ''}|${row.speed ?? ''}|${row.long_context ?? 0}`}
                >
                  <TableCell className='font-mono text-xs'>
                    {row.model}
                  </TableCell>
                  <TableCell>
                    {labels.length ? (
                      <span className='flex flex-wrap gap-1'>
                        {labels.map((l) => (
                          <Badge key={l} variant='outline'>
                            {l}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className='text-xs text-muted-foreground'>
                        <Trans ns='vm' i18nKey='detailCostByModel.standard' />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.requests)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.input_tokens)} / {fmtNum(row.output_tokens)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtNum(row.cache_read_tokens)} /{' '}
                    {fmtNum(row.cache_creation_tokens)}
                  </TableCell>
                  <TableCell className='text-right tabular-nums'>
                    {fmtUsd(row.total_cost, 2)}
                    {unpriced > 0 ? (
                      <div className='text-xs text-[color:var(--status-caution)]'>
                        <Trans
                          ns='vm'
                          i18nKey='detailCostByModel.unpricedEntries'
                          values={{ formattedNum: fmtNum(unpriced) }}
                          count={unpriced}
                        />
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

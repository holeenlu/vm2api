import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { type CredType, credTypeLabel } from '@/lib/cred-type'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TabsContent } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { SearchSelect } from '@/components/search-select'
import {
  dataplaneHint,
  HOP_TRANSPORT_LABEL,
  dataplaneLabel,
} from '@/features/vm/dataplane-contract'
import { TestChatResultCard } from '@/features/vm/test-chat-result-card'
import type { TestChatResult } from '@/features/vm/test-chat-types'

type VmTestTabProps = {
  vm: Vm
  models: { id: string; label?: string; display_name?: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  credType: CredType
  isCodex?: boolean
  dataplane?: string | null
  result: TestChatResult | null
  running: boolean
  modelsRefreshing: boolean
  onModelChange: (value: string) => void
  onPromptChange: (value: string) => void
  onMaxTokensChange: (value: number) => void
  onReasoningEffortChange: (value: string) => void
  onTest: () => void
  onRefreshModels: () => void
  canRefreshModels?: boolean
  schedule?: React.ReactNode
}

const CODEX_EFFORTS = [
  {
    id: 'none',
    get label() {
      return tVm('vm:reasoning.none')
    },
  },
  {
    id: 'low',
    get label() {
      return tVm('vm:reasoning.low')
    },
  },
  {
    id: 'medium',
    get label() {
      return tVm('vm:reasoning.medium')
    },
  },
  {
    id: 'high',
    get label() {
      return tVm('vm:reasoning.high')
    },
  },
  {
    id: 'xhigh',
    get label() {
      return tVm('vm:reasoning.xhigh')
    },
  },
  {
    id: 'max',
    get label() {
      return tVm('vm:reasoning.max')
    },
  },
] as const

export function VmTestTab(props: VmTestTabProps) {
  useTranslation('vm')

  return (
    <TabsContent value='test' className='space-y-3 pt-4'>
      <VmTestPanel {...props} className='max-w-lg' />
    </TabsContent>
  )
}

/** 不依赖 Tabs 上下文的测试面板，详情页 Tab 与弹窗共用。 */
export function VmTestPanel(props: VmTestTabProps & { className?: string }) {
  const { t: tVm } = useTranslation('vm')

  const {
    vm,
    models,
    model,
    prompt,
    maxTokens,
    reasoningEffort,
    credType,
    isCodex = false,
    dataplane,
    result,
    running,
    modelsRefreshing,
    onModelChange,
    onPromptChange,
    onMaxTokensChange,
    onReasoningEffortChange,
    onTest,
    onRefreshModels,
    canRefreshModels = true,
    schedule,
  } = props

  return (
    <>
      <Card className={props.className}>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            <Trans ns='vm' i18nKey='detailTestTab.sendATestMessage' />
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <div className='space-y-1.5'>
            <Label>
              <Trans ns='vm' i18nKey='detailCostByModel.model' />
            </Label>
            <SearchSelect
              label={tVm('vm:detailTestTab.testModel')}
              value={model || models[0]?.id || ''}
              options={models.map((m) => ({
                id: m.id,
                name: m.label || m.display_name || m.id,
              }))}
              searchPlaceholder={tVm('vm:detailTestTab.searchTestModels')}
              onChange={(id) => onModelChange(id || '')}
            />
          </div>
          <div className='space-y-1.5'>
            <Label>
              <Trans ns='vm' i18nKey='labels.prompt' />
            </Label>
            <Textarea
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label>
              {isCodex
                ? tVm('vm:detailTestTab.reasoningLevel')
                : tVm('vm:detailTestTab.reasoningBudget')}
            </Label>
            {isCodex ? (
              <Select
                value={reasoningEffort}
                onValueChange={onReasoningEffortChange}
              >
                <SelectTrigger className='w-40'>
                  <SelectValue
                    placeholder={
                      /* i18n-exempt "medium" -- Literal reasoning effort value accepted by the model API. */ 'medium'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {CODEX_EFFORTS.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type='number'
                min={1}
                max={128000}
                className='w-32'
                value={maxTokens}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  onMaxTokensChange(
                    !Number.isFinite(value) || value <= 0
                      ? 8192
                      : Math.min(128000, Math.max(1, Math.floor(value)))
                  )
                }}
              />
            )}
          </div>
          <div className='space-y-1'>
            <Label>
              <Trans ns='vm' i18nKey='detailTestTab.credentials' />
            </Label>
            <p className='text-xs text-muted-foreground'>
              {isCodex
                ? 'GPT OAuth · Codex kernel / OpenAI Responses'
                : credType === 'none'
                  ? tVm(
                      'vm:detailTestTab.noCredentialsImportCredentialsBeforeTesting'
                    )
                  : tVm('vm:detailTestTab.summary', {
                      value1: credTypeLabel(credType),
                      value2:
                        credType === 'setup-token' || credType === 'apikey'
                          ? tVm(
                              'vm:detailTestTab.inferenceEntryBypassesTheFourOfficialClaudeCodeGates'
                            )
                          : tVm('vm:detailTestTab.officialClaudeCodeEntry'),
                    })}
            </p>
          </div>
          {isCodex ? null : (
            <div className='space-y-1'>
              <Label>
                <Trans ns='vm' i18nKey='detailStatusBoard.kernel' />
              </Label>
              <p className='text-xs text-muted-foreground'>
                {HOP_TRANSPORT_LABEL} · {dataplaneLabel(dataplane)}。
                {dataplaneHint()}
              </p>
            </div>
          )}
          <div className='flex gap-2'>
            <Button onClick={onTest} disabled={running} loading={running}>
              <Trans ns='vm' i18nKey='detailTestTab.startTest' />
            </Button>
            {canRefreshModels ? (
              <Button
                variant='ghost'
                onClick={onRefreshModels}
                loading={modelsRefreshing}
              >
                <Trans ns='vm' i18nKey='detailTestTab.refreshList' />
              </Button>
            ) : null}
          </div>
          {schedule}
        </CardContent>
      </Card>
      <TestChatResultCard result={result} running={running} vm={vm} />
    </>
  )
}

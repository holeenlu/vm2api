import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TestModelsPayload, Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { VmTestPanel } from '@/features/vm/detail-test-tab'
import { testModelsQueryOptions } from '@/features/vm/queries'
import type { TestChatResult } from '@/features/vm/test-chat-types'
import { accountBase, type GatewayAccount } from './accounts-model'

const PLATFORM = 'openai'

function TestBody({ account, vm }: { account: GatewayAccount; vm: Vm }) {
  const { t } = useTranslation(['vm', 'common'])
  const qc = useQueryClient()
  const modelsKey = [...testModelsQueryOptions('').queryKey, PLATFORM]
  const testModels = useQuery({
    queryKey: modelsKey,
    queryFn: () =>
      api<TestModelsPayload>(`/api/panel/test-models?platform=${PLATFORM}`),
  })
  const models = useMemo(
    () => testModels.data?.items || testModels.data?.models || [],
    [testModels.data]
  )
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('hello')
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [result, setResult] = useState<TestChatResult | null>(null)
  useEffect(() => {
    if (models.length && !models.some((item) => item.id === model))
      setModel(models[0].id)
  }, [models, model])

  const send = useMutation({
    mutationFn: () =>
      api<TestChatResult>(
        `${accountBase}/${encodeURIComponent(account.id)}/test-chat`,
        {
          method: 'POST',
          body: JSON.stringify({
            model: model || models[0]?.id,
            prompt,
            reasoning_effort: reasoningEffort,
          }),
        }
      ),
    onSuccess: (data) => {
      setResult(data)
      if (data?.ok)
        toast.success(
          t('vm:useVmTestChat.testSucceededMs', {
            value1: data.duration_ms ?? 0,
          })
        )
      else {
        const code = data?.error?.code
        const msg =
          data?.error?.message || t('vm:testChatResultCard.unknownError')
        toast.error(
          code
            ? t('vm:useVmTestChat.testFailed', { code, msg })
            : t('vm:useVmTestChat.testFailedAlternative', { msg })
        )
      }
    },
    onError: (error: Error) => {
      setResult({
        ok: false,
        duration_ms: 0,
        log: [],
        error: {
          message: error.message,
          ...(isApiError(error)
            ? { code: error.code || undefined, status: error.status }
            : {}),
        },
      })
      toast.error(error.message)
    },
  })
  const refreshModels = useMutation({
    mutationFn: () =>
      api<TestModelsPayload>(
        `/api/panel/test-models?platform=${PLATFORM}&refresh=1`
      ),
    onSuccess: (data) => qc.setQueryData(modelsKey, data),
    onError: (error: Error) =>
      toast.error(error.message || t('vm:useVmTestChat.failedToRefreshModels')),
  })

  return (
    <VmTestPanel
      vm={vm}
      models={models}
      model={model}
      prompt={prompt}
      maxTokens={8192}
      reasoningEffort={reasoningEffort}
      credType='oauth'
      isCodex
      credentialSummary={t('common:codexTestCredential')}
      slotRecovery={false}
      result={result}
      running={send.isPending}
      modelsRefreshing={testModels.isFetching || refreshModels.isPending}
      onModelChange={setModel}
      onPromptChange={setPrompt}
      onMaxTokensChange={() => {}}
      onReasoningEffortChange={setReasoningEffort}
      onTest={() => {
        setResult(null)
        send.mutate()
      }}
      onRefreshModels={() => {
        if (!refreshModels.isPending) refreshModels.mutate()
      }}
    />
  )
}

/** 测试链接（Codex 账号）：经 Gateway Worker 用该账号发一条真实对话。 */
export function GatewayAccountTestDialog({
  account,
  vm,
  onOpenChange,
}: {
  account: GatewayAccount | null
  vm: Vm | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('common')
  return (
    <Dialog open={account != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <Trans
              ns='vm'
              i18nKey='vmTestDialog.testConnection'
              components={{
                part0: <>{vm ? <SlotIdentity vm={vm} compact /> : null}</>,
              }}
            />
          </DialogTitle>
          <DialogDescription>{t('codexTestHelp')}</DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 space-y-3 overflow-y-auto pe-3'>
          {account && vm ? (
            <TestBody key={account.id} account={account} vm={vm} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { type ApiError, api } from '@/lib/api'
import {
  conditionHolds,
  pickSchemaValues,
  schemaErrors,
  type FieldError,
  type SchemaValues,
  type SettingsSchema,
} from '@/lib/schema-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SchemaForm } from '@/components/schema-form'
import { PaneSection } from './scheduler-controls'

type ExecutorSettings = {
  values: SchemaValues
  revision: number
  schema: SettingsSchema
}

const SETTINGS_KEY = ['executor-settings', 'codex']

/** 保存请求体：只提交描述里定义的字段，并带上编辑时的版本（乐观锁）。 */
export function settingsPayload(
  schema: SettingsSchema,
  draft: SchemaValues,
  revision: number
) {
  return {
    values: pickSchemaValues(schema, draft),
    expected_revision: revision,
  }
}

/** 服务端返回的错误里，落在当前不可见字段上的（在区块底部列出，避免无处可见）。 */
export function hiddenErrors(
  schema: SettingsSchema,
  values: SchemaValues,
  serverErrors: FieldError[]
) {
  return serverErrors.filter((item) => {
    const field = schema.fields.find((entry) => entry.key === item.field)
    const group =
      field && schema.groups.find((entry) => entry.id === field.group)
    return (
      !field ||
      !conditionHolds(field.visible_when, values) ||
      !conditionHolds(group?.visible_when, values)
    )
  })
}

/**
 * Codex 本地设置（统一控制面重构 P4.2、P6.2）：账号调度、预热、重置卡、点数超额。
 * 值保存在控制面设置存储（带配置版本），表单按设置描述渲染、保存时由服务端按同一描述校验。
 */
export function CodexExecutorSettingsSection() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setting = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<ExecutorSettings>('/api/panel/gateway-workers/settings'),
  })
  const [draft, setDraft] = useState<SchemaValues>({})
  const [serverErrors, setServerErrors] = useState<FieldError[]>([])
  useEffect(() => {
    if (setting.data) setDraft(setting.data.values)
  }, [setting.data])
  const schema = setting.data?.schema
  const errors = useMemo(
    () => (schema ? schemaErrors(schema, draft) : []),
    [schema, draft]
  )
  const dirty =
    !!setting.data &&
    JSON.stringify(draft) !== JSON.stringify(setting.data.values)
  const save = useMutation({
    mutationFn: () =>
      api<ExecutorSettings>('/api/panel/gateway-workers/settings', {
        method: 'PUT',
        body: JSON.stringify(
          settingsPayload(
            schema as SettingsSchema,
            draft,
            setting.data?.revision ?? 0
          )
        ),
      }),
    onSuccess: async () => {
      setServerErrors([])
      toast.success(t('executorSettings.saved'))
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
    },
    onError: async (error: Error) => {
      // 期间有人改过设置（乐观锁 409）：重新载入最新值
      if ((error as ApiError).status === 409) {
        toast.error(t('executorSettings.conflict'))
        await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
        return
      }
      const fields = (
        (error as ApiError).data as
          { error?: { fields?: FieldError[] } } | undefined
      )?.error?.fields
      setServerErrors(Array.isArray(fields) ? fields : [])
      toast.error(error.message)
    },
  })
  if (!schema) return null
  const busy = setting.isLoading || save.isPending
  return (
    <PaneSection
      icon={SlidersHorizontal}
      title={t('executorSettings.title')}
      desc={t('executorSettings.help')}
      aside={
        <Badge variant='outline'>
          {t('executorSettings.revision', {
            revision: setting.data?.revision ?? 0,
          })}
        </Badge>
      }
    >
      <div className='space-y-6' data-testid='codex-executor-settings'>
        <SchemaForm
          schema={schema}
          value={draft}
          disabled={busy}
          serverErrors={serverErrors}
          onChange={(next) => {
            setDraft(next)
            setServerErrors([])
          }}
        />
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            disabled={busy || !dirty || errors.length > 0}
            onClick={() => save.mutate()}
          >
            {t('executorSettings.save')}
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || !dirty}
            onClick={() => setting.data && setDraft(setting.data.values)}
          >
            {t('executorSettings.reset')}
          </Button>
          {hiddenErrors(schema, draft, serverErrors).map((item) => (
            <span
              key={item.field}
              className='text-xs text-destructive'
              role='alert'
            >
              {(() => {
                const field = schema.fields.find(
                  (entry) => entry.key === item.field
                )
                return `${field ? t(field.label) : item.field}: ${t(
                  'common:schemaFieldInvalid',
                  { reason: item.reason, defaultValue: item.reason }
                )}`
              })()}
            </span>
          ))}
          {errors.length > 0 ? (
            <span className='text-xs text-destructive'>
              {t('executorSettings.invalid', { count: errors.length })}
            </span>
          ) : null}
        </div>
      </div>
    </PaneSection>
  )
}

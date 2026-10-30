import { t } from '@/i18n'

/** 同步目录会重载策略并覆盖草稿；有未保存改动时要先问。没改动就直接同步。 */
export function syncConfirmText(dirty: boolean, label: string): string | null {
  if (!dirty) return null
  return t('models:syncDirtyConfirm', { label: label.trim() })
}

/** 恢复默认不可撤销，无论有没有草稿都要确认。 */
export function resetConfirmText(dirty: boolean): string {
  return dirty ? t('models:resetDirtyConfirm') : t('models:resetConfirm')
}

/** models.dev 拉取失败时网关仍回 200，状态在 `models_dev.status` 里。 */
export type ModelsDevSyncResult = {
  models_dev?: { status?: string; error?: string | null; models?: number }
}

export function modelsDevSyncOutcome(data?: ModelsDevSyncResult): {
  ok: boolean
  text: string
} {
  const status = data?.models_dev
  if (status?.status === 'error') {
    return {
      ok: false,
      text: t('models:modelsDevSyncFailed', {
        error: status.error || t('models:unknownError'),
      }),
    }
  }
  return {
    ok: true,
    text:
      status?.models != null
        ? t('models:modelsDevSyncedCount', { count: status.models })
        : t('models:modelsDevSynced'),
  }
}

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import type { Resource } from './portal-model'

/** Gateway Worker 账号的重新授权弹窗（供应商与运营端账号池共用）。 */
export function GatewayReauthDialog({
  resource,
  apiBase,
  onClose,
  onDone,
}: {
  resource: Resource | null
  /** 账号接口前缀：供应商 `/api/vendor/accounts`，运营端 `/api/admin/vendors/accounts` */
  apiBase: string
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('vendor')
  const key = useRef(crypto.randomUUID())
  const base = resource
    ? `${apiBase}/${encodeURIComponent(resource.id)}/gateway-drafts`
    : ''
  async function prepareDraft(authorizationKind: string) {
    const result = await api<{ draft: { id: string } }>(base, {
      method: 'POST',
      body: JSON.stringify({
        authorization_kind: authorizationKind,
        idempotency_key: key.current,
      }),
    })
    return result.draft.id
  }
  return (
    <Dialog
      open={!!resource}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('authorizeAccount')}</DialogTitle>
          <DialogDescription>
            {t('authorizeAccountDescription')}
          </DialogDescription>
        </DialogHeader>
        {resource && (
          <CodexCredentialPanel
            key={resource.id}
            gatewayAccount
            vm={{
              id: '',
              name: resource.name,
              platform: 'openai',
              family: 'codex',
              can_import_credential: true,
            }}
            initialMode={
              resource.config.authorization_mode === 'codex_account_file'
                ? 'json'
                : 'oauth'
            }
            draftApiBase={base}
            prepareDraft={prepareDraft}
            onCommitted={(data) => {
              if ((data as { projection_pending?: boolean }).projection_pending)
                toast.warning(t('common:codexProjectionPending'))
              onDone()
              onClose()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

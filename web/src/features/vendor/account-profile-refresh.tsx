import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { Resource } from './portal-model'

export function AccountProfileRefresh({
  resource,
  apiBase = '/api/vendor/accounts',
  disabled,
  onChanged,
}: {
  resource: Resource
  apiBase?: string
  disabled?: boolean
  onChanged: () => void | Promise<unknown>
}) {
  const { t } = useTranslation('vendor')
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await api(
        apiBase + '/' + encodeURIComponent(resource.id) + '/profile/refresh',
        { method: 'POST' }
      )
      toast.success(t('identity.refreshed'))
      try {
        await onChanged()
      } catch {
        toast.error(t('wb.refreshFailed'))
      }
    } catch {
      toast.error(t('identity.refreshFailed'))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <DropdownMenuItem
      disabled={disabled || busy || !resource.telemetry?.can_refresh_profile}
      title={
        resource.telemetry?.can_refresh_profile
          ? undefined
          : t('identity.scopeRequired')
      }
      onSelect={(event) => {
        event.preventDefault()
        void refresh()
      }}
    >
      {t(busy ? 'identity.refreshing' : 'identity.refresh')}
    </DropdownMenuItem>
  )
}

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QueryGate } from '@/components/query-gate'
import type {
  BpsEndpoints,
  BpsSettings,
  BpsView,
} from '@/features/gateway-worker/accounts-model'
import { BpsSection } from '@/features/gateway-worker/bps-section'
import type { Resource } from './portal-model'

type VendorBpsView = BpsView & { groups: { id: number; name: string }[] }

/** Gateway 账号的 BPS 授权与设置（供应商门户与运营端账号池共用，需开放 Gateway 运行控制）。 */
export function VendorBpsDialog({
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
  const { t } = useTranslation('common')
  const id = resource ? encodeURIComponent(resource.id) : ''
  const endpoints: BpsEndpoints = {
    drafts: `${apiBase}/${id}/gateway-drafts`,
    draftApiBase: `${apiBase}/${id}/gateway-drafts`,
    import: `${apiBase}/${id}/bps/import`,
    bps: `${apiBase}/${id}/bps`,
  }
  const query = useQuery({
    queryKey: ['vendor-bps', endpoints.bps],
    queryFn: () => api<VendorBpsView>(endpoints.bps),
    enabled: !!resource,
  })
  const [settings, setSettings] = useState<BpsSettings | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setSettings(query.data?.bps || null)
  }, [query.data])
  async function refresh() {
    await query.refetch()
    onDone()
  }
  async function save() {
    if (!settings) return
    setSaving(true)
    try {
      await api(endpoints.bps, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      })
      toast.success(t('codexActionDone'))
      await refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
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
          <DialogTitle>
            {t('codexBpsTitle')}
            {resource ? ` · ${resource.name}` : ''}
          </DialogTitle>
          {/* 说明已在 BPS 区域内显示，这里只供读屏 */}
          <DialogDescription className='sr-only'>
            {t('codexBpsHelp')}
          </DialogDescription>
        </DialogHeader>
        <QueryGate loading={query.isPending} error={query.error}>
          {query.data && (
            <div className='space-y-4'>
              <BpsSection
                view={query.data}
                endpoints={endpoints}
                groups={query.data.groups}
                value={settings}
                onChange={setSettings}
                onChanged={refresh}
              />
              <div className='flex justify-end gap-2'>
                <Button variant='outline' disabled={saving} onClick={onClose}>
                  {t('cancel')}
                </Button>
                {query.data.bps_grant ? (
                  <Button disabled={saving || !settings} onClick={save}>
                    {t('vendor:wb.save')}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </QueryGate>
      </DialogContent>
    </Dialog>
  )
}

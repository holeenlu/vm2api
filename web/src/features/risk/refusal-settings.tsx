import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefusalGuardConfig } from '@/types/panel-routing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { formatTimestamp as fmtExpiresAt } from '@/features/logs/display-time'
import { Group, ToggleItem, ToggleList } from './blocks'
import { refusalGuardsQueryOptions } from './queries'

const SIMILARITY_CHOICES = [80, 85, 90, 95] as const

function shortFp(fp: string) {
  const s = String(fp || '')
  if (s.length <= 16) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

/** Changes here save immediately: each switch and list action is one PUT/DELETE. */
export function RefusalSettings() {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())
  const [clearOpen, setClearOpen] = useState(false)
  const [clearDevicesOpen, setClearDevicesOpen] = useState(false)
  const [deleteFp, setDeleteFp] = useState<string | null>(null)
  const [unblockId, setUnblockId] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (patch: Partial<RefusalGuardConfig>) =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: async (data) => {
      toast.success(translate('risk:refusalSettingsSaved'))
      qc.setQueryData(refusalGuardsQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (fingerprint: string) =>
      api<RefusalGuardConfig>(`/api/panel/refusal-guards/${fingerprint}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success(translate('risk:fingerprintDeleted'))
      setDeleteFp(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clear = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success(translate('risk:refusalCacheCleared'))
      setClearOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const unblock = useMutation({
    mutationFn: (deviceId: string) =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ device_id: deviceId }),
      }),
    onSuccess: async () => {
      toast.success(translate('risk:deviceUnblocked'))
      setUnblockId(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clearDevices = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-device-blocks', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success(translate('risk:allDevicesUnblocked'))
      setClearDevicesOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!q.data) return <div className='h-40 animate-pulse bg-muted/40' />
  const data = q.data
  const devices = data.devices ?? []
  const deviceCount = data.device_count ?? devices.length
  const similarity = data.similarity ?? 90
  const deleting = data.items.find((item) => item.fingerprint === deleteFp)

  return (
    <div className='space-y-8 p-4'>
      <Group
        title={translate('risk:whenToBlock')}
        hint={translate('risk:refusalSettingsDescription')}
      >
        <ToggleList>
          <ToggleItem
            label={translate('risk:blockRepeatedRefusals')}
            desc={translate('risk:refusalEnvironmentHint')}
          >
            <Switch
              checked={data.enabled}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:blockSimilar')}
            desc={translate('risk:excludeSharedSystem')}
          >
            <Switch
              checked={data.similarity_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ similarity_enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:blockedDevice')}
            desc={translate('risk:banDeviceHint')}
          >
            <Switch
              checked={data.device_block_enabled !== false}
              disabled={save.isPending || !data.enabled}
              onCheckedChange={(v) => save.mutate({ device_block_enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:similarity')}
            desc={translate('risk:similarityHint')}
          >
            <div
              role='radiogroup'
              aria-label={translate('risk:similarity')}
              className='flex rounded-lg bg-muted p-0.5'
            >
              {SIMILARITY_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type='button'
                  role='radio'
                  aria-checked={similarity === choice}
                  disabled={
                    save.isPending ||
                    !data.enabled ||
                    data.similarity_enabled === false
                  }
                  onClick={() => save.mutate({ similarity: choice })}
                  className='cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm'
                >
                  {choice}%
                </button>
              ))}
            </div>
          </ToggleItem>
        </ToggleList>
      </Group>

      <div className='grid gap-8 xl:grid-cols-2'>
        <Group
          title={translate('risk:bannedDevices')}
          hint={
            deviceCount
              ? devices.length < deviceCount
                ? translate('risk:showRecentCount', {
                    p0: devices.length,
                    p1: deviceCount,
                  })
                : translate('risk:deviceCount', { count: deviceCount })
              : translate('risk:noneYet')
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!deviceCount || clearDevices.isPending}
              onClick={() => setClearDevicesOpen(true)}
            >
              {translate('risk:unblockAll')}
            </Button>
          }
        >
          {devices.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {devices.map((item) => (
                <li
                  key={item.device_id}
                  className='flex items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate font-mono text-xs'>
                      {item.device_id}
                    </p>
                    <p className='text-xs text-muted-foreground tabular-nums'>
                      {translate('risk:deviceHitDetails', {
                        reason: item.reason || 'refusal_guard',
                        count: item.hit_count,
                        lastSeen: fmtExpiresAt(item.last_seen_at),
                      })}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setUnblockId(item.device_id)}
                  >
                    {translate('risk:unblock')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
        <Group
          title={translate('risk:refusalFingerprints')}
          hint={
            data.count
              ? data.items.length < data.count
                ? translate('risk:showRecentCount', {
                    p0: data.items.length,
                    p1: data.count,
                  })
                : translate('risk:itemCount', { count: data.count })
              : translate('risk:noRefusalsYet')
          }
          action={
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={!data.count || clear.isPending}
              onClick={() => setClearOpen(true)}
            >
              {translate('risk:clearFingerprints')}
            </Button>
          }
        >
          {data.items.length ? (
            <ul className='max-h-80 divide-y overflow-y-auto rounded-xl border'>
              {data.items.map((item) => (
                <li
                  key={item.fingerprint}
                  className='flex items-center justify-between gap-2 px-3 py-2'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm'>
                      {item.preview || translate('risk:noPreview')}
                    </p>
                    <p className='truncate font-mono text-xs text-muted-foreground tabular-nums'>
                      {translate('risk:fingerprintHitDetails', {
                        model: item.model || '—',
                        fingerprint: shortFp(item.fingerprint),
                        count: item.hit_count,
                        lastSeen: fmtExpiresAt(item.last_seen_at),
                      })}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='cursor-pointer'
                    onClick={() => setDeleteFp(item.fingerprint)}
                  >
                    {translate('risk:delete')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Group>
      </div>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={translate('risk:clearRefusalCache')}
        desc={translate('risk:clearRefusalCacheHint')}
        confirmText={translate('risk:clear')}
        cancelBtnText={translate('risk:cancel')}
        destructive
        isLoading={clear.isPending}
        handleConfirm={() => clear.mutate()}
      />
      <ConfirmDialog
        open={clearDevicesOpen}
        onOpenChange={setClearDevicesOpen}
        title={translate('risk:unblockAllDevices')}
        desc={translate('risk:unblockAllDevicesHint')}
        confirmText={translate('risk:unblockAll')}
        cancelBtnText={translate('risk:cancel')}
        destructive
        isLoading={clearDevices.isPending}
        handleConfirm={() => clearDevices.mutate()}
      />
      <ConfirmDialog
        open={!!deleteFp}
        onOpenChange={(open) => {
          if (!open) setDeleteFp(null)
        }}
        title={translate('risk:deleteFingerprint')}
        desc={translate('risk:deleteFingerprintHint', {
          p0: deleting?.preview || shortFp(deleteFp || ''),
        })}
        confirmText={translate('risk:delete')}
        cancelBtnText={translate('risk:cancel')}
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (deleteFp) remove.mutate(deleteFp)
        }}
      />
      <ConfirmDialog
        open={!!unblockId}
        onOpenChange={(open) => {
          if (!open) setUnblockId(null)
        }}
        title={translate('risk:unblockDevice')}
        desc={translate('risk:unblockDeviceHint', { p0: unblockId || '' })}
        confirmText={translate('risk:unblock')}
        cancelBtnText={translate('risk:cancel')}
        destructive
        isLoading={unblock.isPending}
        handleConfirm={() => {
          if (unblockId) unblock.mutate(unblockId)
        }}
      />
    </div>
  )
}

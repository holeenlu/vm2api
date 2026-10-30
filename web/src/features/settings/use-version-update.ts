import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import {
  refreshVersionStatus,
  versionQueryOptions,
  type ReleaseStatus,
} from './queries'

export function useVersionUpdate() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const [upgradeTarget, setUpgradeTarget] = useState<string | null>(null)
  const version = useQuery({
    ...versionQueryOptions(),
    refetchInterval: (query) =>
      upgradeTarget || query.state.data?.upgrade?.state === 'running'
        ? 2000
        : 5 * 60_000,
  })
  const check = useMutation({ mutationFn: () => refreshVersionStatus(qc) })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const data = version.data
  const checkFailed =
    version.isError || !!data?.source_error || data?.check_status === 'failed'
  const updateRunning = !!upgradeTarget || data?.upgrade?.state === 'running'

  useEffect(() => {
    if (!upgradeTarget) return
    if (data?.upgrade?.target !== upgradeTarget) return
    if (data.upgrade.state === 'failed') {
      setUpgradeTarget(null)
      toast.error(t('about.upgradeFailed'))
    } else if (
      data.upgrade.state === 'succeeded' &&
      data.current_tag === upgradeTarget
    ) {
      setUpgradeTarget(null)
      window.location.reload()
    }
  }, [data, upgradeTarget, t])

  const upgrade = useMutation({
    mutationFn: () =>
      api<ReleaseStatus>('/api/panel/update', {
        method: 'POST',
        body: JSON.stringify({
          confirm: true,
          version: data?.latest_tag,
        }),
      }),
    onSuccess: async (payload) => {
      setConfirmOpen(false)
      if (payload?.message === 'already_latest') {
        toast.success(
          t('about.upToDateVersion', { value1: payload.current_tag })
        )
        return
      }
      if (payload?.started) {
        setUpgradeTarget(payload.target || payload.latest_tag)
        qc.setQueryData(versionQueryOptions().queryKey, payload)
        toast.info(
          t('about.upgrading', { value1: payload.target || payload.latest_tag })
        )
      }
    },
    onError: (error: Error) => {
      setConfirmOpen(false)
      if (isApiError(error) && error.code === 'host_upgrade_required') {
        const command =
          (error.data as { command?: string } | undefined)?.command ||
          data?.upgrade_command
        toast.error(error.message)
        if (command) {
          copyText(command)
            .then((ok) => ok && toast.success(t('about.hostCommandCopied')))
            .catch(() => undefined)
        }
        return
      }
      if (
        error instanceof TypeError ||
        /failed to fetch|network|load failed/i.test(error.message)
      ) {
        setUpgradeTarget(data?.latest_tag || null)
        toast.info(t('about.connectionLost'))
        void qc.invalidateQueries({ queryKey: versionQueryOptions().queryKey })
        return
      }
      toast.error(error.message)
    },
  })

  return {
    data,
    version,
    check,
    upgrade,
    checkFailed,
    updateRunning,
    upgradeTarget,
    confirmOpen,
    setConfirmOpen,
  }
}

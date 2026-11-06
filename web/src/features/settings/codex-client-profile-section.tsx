import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClientProfileSelection } from '@/types/panel-keys'
import { Fingerprint } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEFAULT_CLIENT_PROFILE, cleanProfile } from './codex-profile'
import { ClientProfileEditor } from './codex-profile-editor'
import { PaneSection } from './scheduler-controls'

type Deployment = { residency?: string; accountRoutingOverride?: string }
type ProfileSetting = {
  selection: ClientProfileSelection
  deployment: Deployment
}
type Preview = {
  user_agent: string
  headers: Record<string, string>
  verified_at?: string
}
type ReleaseEntry = {
  client: string
  platform: string
  arch: string
  history?: {
    codexVersion: string
    desktopVersion?: string
    desktopBuild?: string
    verifiedAt?: string
  }[]
  checked_at?: string
  error?: string
}

const PROFILE_KEY = ['codex-client-profile']

// Gateway Worker 上游客户端画像：通用设置（Key 可单独覆盖），Worker 按官方发布资料解析身份头。
export function CodexClientProfileSection() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setting = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => api<ProfileSetting>('/api/panel/codex-client-profile'),
  })
  const releases = useQuery({
    queryKey: [...PROFILE_KEY, 'releases'],
    queryFn: () =>
      api<{ releases: ReleaseEntry[] }>(
        '/api/panel/codex-client-profile/releases'
      ),
    retry: false,
  })
  const [selection, setSelection] = useState<ClientProfileSelection>(
    DEFAULT_CLIENT_PROFILE
  )
  const [deployment, setDeployment] = useState<Deployment>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  useEffect(() => {
    if (!setting.data) return
    setSelection(setting.data.selection || DEFAULT_CLIENT_PROFILE)
    setDeployment(setting.data.deployment || {})
  }, [setting.data])
  const payload = () => ({ selection: cleanProfile(selection), deployment })
  const previewMutation = useMutation({
    mutationFn: () =>
      api<Preview>('/api/panel/codex-client-profile/preview', {
        method: 'POST',
        body: JSON.stringify(payload()),
      }),
    onSuccess: setPreview,
    onError: (error: Error) => {
      setPreview(null)
      toast.error(error.message)
    },
  })
  const save = useMutation({
    mutationFn: () =>
      api<ProfileSetting>('/api/panel/codex-client-profile', {
        method: 'PUT',
        body: JSON.stringify(payload()),
      }),
    onSuccess: async () => {
      toast.success(t('codexProfile.saved'))
      await queryClient.invalidateQueries({ queryKey: PROFILE_KEY })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = setting.isLoading || save.isPending
  return (
    <PaneSection
      icon={Fingerprint}
      title={t('codexProfile.title')}
      desc={t('codexProfile.help')}
    >
      <ClientProfileEditor
        idPrefix='codex-profile'
        value={selection}
        disabled={busy}
        onChange={(next) => {
          setSelection(next)
          setPreview(null)
        }}
      />
      <div className='grid gap-3 sm:grid-cols-2'>
        <Label className='flex flex-col items-start gap-2'>
          {t('codexProfile.residency')}
          <Input
            disabled={busy}
            value={deployment.residency || ''}
            placeholder={t('codexProfile.optional')}
            onChange={(event) =>
              setDeployment({ ...deployment, residency: event.target.value })
            }
          />
        </Label>
        <Label className='flex flex-col items-start gap-2'>
          {t('codexProfile.routingOverride')}
          <Input
            disabled={busy}
            value={deployment.accountRoutingOverride || ''}
            placeholder={t('codexProfile.optional')}
            onChange={(event) =>
              setDeployment({
                ...deployment,
                accountRoutingOverride: event.target.value,
              })
            }
          />
        </Label>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          size='sm'
          disabled={busy || previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {t('codexProfile.preview')}
        </Button>
        <Button size='sm' disabled={busy} onClick={() => save.mutate()}>
          {t('codexProfile.save')}
        </Button>
      </div>
      {preview ? (
        <div className='space-y-1 rounded border bg-muted/30 p-3 font-mono text-xs break-all'>
          {Object.entries(preview.headers)
            .filter(([key]) => key !== 'authorization')
            .map(([key, value]) => (
              <div key={key}>
                <span className='text-muted-foreground'>{key}: </span>
                {value}
              </div>
            ))}
        </div>
      ) : null}
      <div className='space-y-1'>
        <p className='text-sm font-medium'>{t('codexProfile.releases')}</p>
        {releases.isError ? (
          <p className='text-xs text-muted-foreground'>
            {t('codexProfile.releasesUnavailable')}
          </p>
        ) : (
          <div className='grid gap-1 text-xs sm:grid-cols-2'>
            {(releases.data?.releases || []).map((entry) => {
              const latest = entry.history?.[0]
              return (
                <div
                  key={`${entry.client}-${entry.platform}`}
                  className='rounded border px-2 py-1'
                >
                  <span className='font-medium'>
                    {entry.client === 'cli'
                      ? /* i18n-exempt "CLI" -- Codex CLI product name. */ 'CLI'
                      : /* i18n-exempt "Desktop" -- Codex Desktop product name. */ 'Desktop'}{' '}
                    · {entry.platform}
                  </span>{' '}
                  <span className='font-mono'>
                    {latest?.codexVersion || '—'}
                    {latest?.desktopVersion
                      ? ` / ${latest.desktopVersion} (${latest.desktopBuild})`
                      : ''}
                  </span>
                  {entry.error ? (
                    <span className='block text-destructive'>
                      {t('codexProfile.checkFailed', { value: entry.error })}
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </PaneSection>
  )
}

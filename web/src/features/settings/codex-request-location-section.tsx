import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RequestLocation } from '@/types/panel-vm'
import { MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { RequestLocationFields } from './request-location-fields'
import { PaneSection } from './scheduler-controls'

type Setting = { enabled: boolean; location: RequestLocation }
const KEY = ['codex-request-location']

// Gateway Worker 全局请求位置：账号代理未设置位置时，改写环境/时间上下文的时区与 web_search 的位置。
export function CodexRequestLocationSection() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setting = useQuery({
    queryKey: KEY,
    queryFn: () => api<Setting>('/api/panel/codex-request-location'),
  })
  const [enabled, setEnabled] = useState(false)
  const [location, setLocation] = useState<RequestLocation>({
    country: '',
    region: '',
    city: '',
    timezone: '',
  })
  useEffect(() => {
    if (!setting.data) return
    setEnabled(setting.data.enabled)
    setLocation(setting.data.location)
  }, [setting.data])
  const save = useMutation({
    mutationFn: () =>
      api<Setting>('/api/panel/codex-request-location', {
        method: 'PUT',
        body: JSON.stringify({ enabled, location }),
      }),
    onSuccess: async () => {
      toast.success(t('requestLocation.saved'))
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = setting.isLoading || save.isPending
  return (
    <PaneSection
      icon={MapPin}
      title={t('requestLocation.title')}
      desc={t('requestLocation.help')}
    >
      <div className='flex items-center justify-between gap-3'>
        <Label htmlFor='codex-request-location-enabled'>
          {t('requestLocation.enabled')}
        </Label>
        <Switch
          id='codex-request-location-enabled'
          checked={enabled}
          disabled={busy}
          onCheckedChange={setEnabled}
        />
      </div>
      <RequestLocationFields
        idPrefix='codex-request-location'
        value={location}
        disabled={busy}
        onChange={setLocation}
      />
      <div>
        <Button size='sm' disabled={busy} onClick={() => save.mutate()}>
          {t('requestLocation.save')}
        </Button>
      </div>
    </PaneSection>
  )
}

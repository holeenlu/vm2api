import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/setting-row'

type LogsPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function LogsPane({ value: logging, onChange }: LogsPaneProps) {
  const { t } = useTranslation('settings')

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('logs.title')}</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label={t('logs.mode')}>
          <Select
            value={String(logging.mode || 'normal')}
            onValueChange={(mode) => onChange({ ...logging, mode })}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='off'>{t('off')}</SelectItem>
              <SelectItem value='normal'>{t('normal')}</SelectItem>
              <SelectItem value='debug'>Debug</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={t('logs.retentionDays')}>
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.retain_days ?? 7)}
            onChange={(event) =>
              onChange({
                ...logging,
                retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label={t('logs.debugRetentionDays')}
          desc={t('logs.debugRetentionHelp')}
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={90}
            value={Number(logging.debug_retain_days ?? 3)}
            onChange={(event) =>
              onChange({
                ...logging,
                debug_retain_days: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label={t('logs.storageLimit')} desc={t('logs.storageHelp')}>
          <Input
            className='w-24'
            type='number'
            min={0}
            value={Number(logging.max_mb ?? 2048)}
            onChange={(event) =>
              onChange({
                ...logging,
                max_mb: Number(event.target.value),
              })
            }
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}

import type { PanelRole } from '@/types/panel-auth'
import { useTranslation } from 'react-i18next'
import { ERROR_CLASS_IDS } from '@/lib/log-mute'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { errorClassLabel } from '@/features/logs/log-display'
import type { LogsFilterState } from '../search'

const ALL = '__all__'
const NOT_200 = '!200'

export function StatusFilters({
  role,
  filters,
  statusCodes,
  onChange,
}: {
  role: PanelRole | undefined
  filters: LogsFilterState
  statusCodes: number[]
  onChange: (filters: LogsFilterState) => void
}) {
  const { t: translate } = useTranslation('logs')
  const COMMON_STATUS_CODES: [number, string][] = [
    [200, translate('logs:statusSuccess')],
    [400, translate('logs:statusBadRequest')],
    [401, translate('logs:statusUnauthorized')],
    [429, translate('logs:statusRateLimited')],
    [500, translate('logs:statusServerError')],
    [503, translate('logs:statusUnavailable')],
    [529, translate('logs:statusOverloaded')],
  ]

  const common = COMMON_STATUS_CODES.map(([code]) => code)
  const dynamic = statusCodes.filter((code) => !common.includes(code))
  const statusValue = filters.excludeStatus200
    ? NOT_200
    : filters.statusCode != null
      ? String(filters.statusCode)
      : ALL

  return (
    <>
      <div className='space-y-2'>
        <Label>{translate('logs:statusCode')}</Label>
        <Select
          value={statusValue}
          onValueChange={(value) =>
            onChange({
              ...filters,
              excludeStatus200: value === NOT_200 || undefined,
              statusCode:
                value === ALL || value === NOT_200
                  ? undefined
                  : Number.parseInt(value, 10),
            })
          }
        >
          <SelectTrigger
            aria-label={translate('logs:statusCode')}
            className='w-full'
          >
            <SelectValue placeholder={translate('logs:allStatusCodes')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {translate('logs:allStatusCodes')}
            </SelectItem>
            <SelectItem value={NOT_200}>{translate('logs:non2xx')}</SelectItem>
            {COMMON_STATUS_CODES.map(([code, label]) => (
              <SelectItem key={code} value={String(code)}>
                {label}
              </SelectItem>
            ))}
            {dynamic.map((code) => (
              <SelectItem key={code} value={String(code)}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label htmlFor='logs-min-retry'>
            {translate('logs:minimumRetries')}
          </Label>
          <Input
            id='logs-min-retry'
            type='number'
            min={0}
            inputMode='numeric'
            placeholder={translate('logs:retryCountPlaceholder')}
            value={filters.minRetry ?? ''}
            onChange={(event) => {
              const n = Number.parseInt(event.target.value, 10)
              onChange({
                ...filters,
                minRetry: Number.isFinite(n) && n >= 0 ? n : undefined,
              })
            }}
          />
        </div>
      ) : null}
      <div className='space-y-2'>
        <Label>{translate('logs:errorClass')}</Label>
        <Select
          value={filters.errorClass ?? ALL}
          onValueChange={(value) =>
            onChange({
              ...filters,
              errorClass: value === ALL ? undefined : value,
            })
          }
        >
          <SelectTrigger
            aria-label={translate('logs:errorClass')}
            className='w-full'
          >
            <SelectValue placeholder={translate('logs:allClasses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{translate('logs:allClasses')}</SelectItem>
            {ERROR_CLASS_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {errorClassLabel(id)}（{id}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label htmlFor='logs-debug'>{translate('logs:debugSampling')}</Label>
          <div className='flex h-9 items-center justify-between rounded-md border border-input px-3'>
            <Label htmlFor='logs-debug' className='text-sm font-normal'>
              {translate('logs:debugOnly')}
            </Label>
            <Switch
              id='logs-debug'
              checked={!!filters.debugOnly}
              onCheckedChange={(checked) =>
                onChange({ ...filters, debugOnly: checked || undefined })
              }
            />
          </div>
        </div>
      ) : null}
    </>
  )
}

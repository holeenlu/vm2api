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
import { errorClassLabel } from '@/features/logs/log-display'
import type { LogsFilterState } from '../search'

const ALL = '__all__'
const NOT_200 = '!200'

export function StatusFilters({
  filters,
  statusCodes,
  onChange,
}: {
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
    <div className='grid gap-4 sm:grid-cols-2'>
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
          <SelectTrigger className='w-full'>
            <SelectValue placeholder={translate('logs:allStatusCodes')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {translate('logs:allStatusCodes')}
            </SelectItem>
            <SelectItem value={NOT_200}>
              {translate('logs:non200Requests')}
            </SelectItem>
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
      <div className='space-y-2'>
        <Label>{translate('logs:minimumRetries')}</Label>
        <Input
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
          <SelectTrigger className='w-full'>
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
    </div>
  )
}

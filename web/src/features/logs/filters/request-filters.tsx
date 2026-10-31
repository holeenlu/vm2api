import type { PanelRole } from '@/types/panel-auth'
import type { UsageLogFilterOptions } from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SearchSelect } from '@/components/search-select'
import type { LogsFilterState } from '../search'

export function OptionSelect({
  label,
  allLabel,
  value,
  values,
  loading,
  onChange,
}: {
  label: string
  allLabel: string
  value: string | undefined
  values: string[]
  loading: boolean
  onChange: (value: string | undefined) => void
}) {
  const { t: translate } = useTranslation('logs')

  // 当前值可能来自深链、不在近期选项里：补进列表，免得 Select 显示空白。
  const items = value && !values.includes(value) ? [value, ...values] : values
  return (
    <div className='space-y-2'>
      <Label>{label}</Label>
      <SearchSelect
        label={label}
        value={value}
        options={items.map((id) => ({ id, name: id }))}
        allLabel={allLabel}
        searchPlaceholder={translate('logs:searchField', { p0: label })}
        loading={loading}
        onChange={onChange}
      />
    </div>
  )
}

export function RequestFilters({
  role,
  filters,
  options,
  optionsLoading,
  onChange,
}: {
  role: PanelRole | undefined
  filters: LogsFilterState
  options: UsageLogFilterOptions | undefined
  optionsLoading: boolean
  onChange: (filters: LogsFilterState) => void
}) {
  const { t: translate } = useTranslation('logs')

  return (
    <>
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label htmlFor='actual-response-model-mismatch-filter'>
            {translate('logs:upstreamModelAudit')}
          </Label>
          <div className='flex items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2'>
            <Label
              htmlFor='actual-response-model-mismatch-filter'
              className='text-sm font-normal'
            >
              {translate('logs:onlyMismatches')}
            </Label>
            <Switch
              id='actual-response-model-mismatch-filter'
              checked={!!filters.mismatch}
              onCheckedChange={(on) =>
                onChange({ ...filters, mismatch: on || undefined })
              }
            />
          </div>
        </div>
      ) : null}
      <OptionSelect
        label={translate('logs:endpoint')}
        allLabel={translate('logs:allEndpoints')}
        value={filters.endpoint}
        values={options?.endpoints ?? []}
        loading={optionsLoading}
        onChange={(endpoint) => onChange({ ...filters, endpoint })}
      />
      <OptionSelect
        label={translate('logs:protocol')}
        allLabel={translate('logs:allProtocols')}
        value={filters.protocol}
        values={options?.protocols ?? []}
        loading={optionsLoading}
        onChange={(protocol) => onChange({ ...filters, protocol })}
      />
    </>
  )
}

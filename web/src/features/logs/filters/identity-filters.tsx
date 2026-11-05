import type { PanelRole } from '@/types/panel-auth'
import {
  USAGE_PLATFORMS,
  type UsageLogFilterOptions,
} from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SearchSelect } from '@/components/search-select'
import { canFilterLogUsers } from '../filter-policy'
import type { LogsFilterState } from '../search'
import {
  PLATFORM_LABELS,
  reconcileFilters,
  scopeFilterOptions,
} from './linkage'

const ALL = '__all__'
function OptionSelect({
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

export function IdentityFilters({
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

  const keys = (options?.keys ?? []).filter(
    (key) => !filters.userId || key.userId === filters.userId
  )
  const scoped = scopeFilterOptions(filters, options)
  const relink = (next: LogsFilterState) =>
    onChange(reconcileFilters(next, options))
  return (
    <>
      {canFilterLogUsers(role, filters.scope) ? (
        <div className='space-y-2'>
          <Label>{translate('logs:user')}</Label>
          <SearchSelect
            label={translate('logs:user')}
            value={filters.userId}
            options={options?.users ?? []}
            allLabel={translate('logs:allUsers')}
            searchPlaceholder={translate('logs:searchUsers')}
            emptyLabel={translate('logs:noMatchingUsers')}
            loading={optionsLoading}
            onChange={(userId) =>
              onChange({ ...filters, userId, keyId: undefined })
            }
          />
        </div>
      ) : null}
      <div className='space-y-2'>
        <Label>{translate('logs:apiKey')}</Label>
        <SearchSelect
          value={filters.keyId}
          options={keys}
          allLabel={translate('logs:allKeys')}
          label={translate('logs:apiKey')}
          searchPlaceholder={translate('logs:searchKeys')}
          loading={optionsLoading}
          onChange={(keyId) => onChange({ ...filters, keyId })}
        />
      </div>
      <div className='space-y-2'>
        <Label>{translate('logs:platform')}</Label>
        {/* 包一层：Radix 隐藏的原生 select 会吃到 space-y 的上边距，撑高单元格 */}
        <div>
          <Select
            value={filters.platform ?? ALL}
            onValueChange={(value) =>
              relink({
                ...filters,
                platform: USAGE_PLATFORMS.find((p) => p === value),
              })
            }
          >
            <SelectTrigger
              aria-label={translate('logs:platform')}
              className='w-full'
            >
              <SelectValue placeholder={translate('logs:allPlatforms')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>
                {translate('logs:allPlatforms')}
              </SelectItem>
              {USAGE_PLATFORMS.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  {PLATFORM_LABELS[platform]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <OptionSelect
        label={translate('logs:model')}
        allLabel={translate('logs:allModels')}
        value={filters.model}
        values={scoped.models}
        loading={optionsLoading}
        onChange={(model) => onChange({ ...filters, model })}
      />
      <div className='space-y-2'>
        <Label>{translate('logs:usageGroup')}</Label>
        <SearchSelect
          label={translate('logs:usageGroup')}
          value={filters.groupId}
          options={scoped.groups}
          allLabel={translate('logs:allGroups')}
          searchPlaceholder={translate('logs:searchUsageGroup')}
          loading={optionsLoading}
          onChange={(groupId) => relink({ ...filters, groupId })}
        />
      </div>
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label>{translate('logs:upstreamAccount')}</Label>
          <SearchSelect
            label={translate('logs:upstreamAccount')}
            value={filters.accountId}
            options={scoped.accounts}
            allLabel={translate('logs:allAccounts')}
            searchPlaceholder={translate('logs:searchAccounts')}
            loading={optionsLoading}
            onChange={(accountId) => onChange({ ...filters, accountId })}
          />
        </div>
      ) : null}
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label>{translate('logs:slot')}</Label>
          <SearchSelect
            label={translate('logs:slot')}
            value={filters.vmId}
            options={scoped.vms}
            allLabel={translate('logs:allSlots')}
            searchPlaceholder={translate('logs:searchSlots')}
            emptyLabel={translate('logs:noMatchingProviders')}
            loading={optionsLoading}
            onChange={(vmId) => onChange({ ...filters, vmId })}
          />
        </div>
      ) : null}
    </>
  )
}

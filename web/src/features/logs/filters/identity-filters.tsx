import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PanelRole } from '@/types/panel-auth'
import type { UsageLogFilterOptions } from '@/types/panel-usage-logs'
import { useTranslation } from 'react-i18next'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SearchSelect } from '@/components/search-select'
import { canFilterLogUsers } from '../filter-policy'
import { usageLogSessionSuggestionsQueryOptions } from '../queries'
import type { LogsFilterState } from '../search'
import { OptionSelect } from './request-filters'

function SessionIdInput({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
}) {
  const { t: translate } = useTranslation('logs')

  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const draft = value ?? ''
  // 300ms 去抖：每次按键都打后端没有意义，前缀匹配也至少要 2 个字符。
  useEffect(() => {
    const id = setTimeout(() => setTerm(draft.trim()), 300)
    return () => clearTimeout(id)
  }, [draft])
  const suggestions = useQuery({
    ...usageLogSessionSuggestionsQueryOptions(term),
    enabled: open && term.length >= 2,
  })

  return (
    <Popover open={open && draft.trim().length >= 2} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          aria-label={translate('logs:sessionId')}
          value={draft}
          placeholder={translate('logs:searchSessionId')}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value.trim() || undefined)
            setOpen(true)
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        className='w-[320px] p-0'
        align='start'
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList className='max-h-[250px] overflow-y-auto'>
            {suggestions.isFetching && !suggestions.data ? (
              <div className='p-2 text-center text-sm text-muted-foreground'>
                {translate('logs:loading')}
              </div>
            ) : (
              <CommandEmpty>
                {translate('logs:noMatchingSessions')}
              </CommandEmpty>
            )}
            <CommandGroup>
              {(suggestions.data ?? []).map((id) => (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    onChange(id)
                    setOpen(false)
                  }}
                  className='cursor-pointer'
                >
                  <span className='flex-1 truncate font-mono text-xs'>
                    {id}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
      <OptionSelect
        label={translate('logs:model')}
        allLabel={translate('logs:allModels')}
        value={filters.model}
        values={(options?.models ?? []).filter((model) => model.trim())}
        loading={optionsLoading}
        onChange={(model) => onChange({ ...filters, model })}
      />
      <div className='space-y-2'>
        <Label>{translate('logs:usageGroup')}</Label>
        <SearchSelect
          label={translate('logs:usageGroup')}
          value={filters.groupId}
          options={options?.groups ?? []}
          allLabel={translate('logs:allGroups')}
          searchPlaceholder={translate('logs:searchUsageGroup')}
          loading={optionsLoading}
          onChange={(groupId) => onChange({ ...filters, groupId })}
        />
      </div>
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label>{translate('logs:upstreamAccount')}</Label>
          <SearchSelect
            label={translate('logs:upstreamAccount')}
            value={filters.accountId}
            options={options?.accounts ?? []}
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
            options={options?.vms ?? []}
            allLabel={translate('logs:allSlots')}
            searchPlaceholder={translate('logs:searchSlots')}
            emptyLabel={translate('logs:noMatchingProviders')}
            loading={optionsLoading}
            onChange={(vmId) => onChange({ ...filters, vmId })}
          />
        </div>
      ) : null}
      {role === 'super_admin' ? (
        <div className='space-y-2'>
          <Label>{translate('logs:sessionId')}</Label>
          <SessionIdInput
            value={filters.sessionId}
            onChange={(sessionId) => onChange({ ...filters, sessionId })}
          />
        </div>
      ) : null}
    </>
  )
}

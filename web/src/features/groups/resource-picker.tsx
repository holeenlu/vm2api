import { useEffect, useMemo, useState } from 'react'
import type { ApiEndpoint } from '@/types/panel-api-endpoints'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CommercialGroup } from './queries'
import { groupBackendKind, type ResourceKind } from './resource-backend'

type ResourcePickerProps = {
  group: CommercialGroup
  kind: ResourceKind
  onKindChange: (kind: ResourceKind) => void
  value: string[]
  onChange: (ids: string[]) => void
  priorities: Record<string, number>
  onPriorityChange: (id: string, value: number) => void
  vms: Vm[]
  endpoints: ApiEndpoint[]
  staff: boolean
  loading: boolean
  error?: Error | null
}

type FilterStatus = 'all' | 'ok' | 'limited' | 'bad'
type Membership = 'all' | 'current' | 'other' | 'none'

type ResourceRow = {
  id: string
  name: string
  sub: string
  kind: ResourceKind
  platform: 'anthropic' | 'openai' | 'unknown'
  status: FilterStatus
  statusText: string
  groups: { id: number; name: string }[]
  priority?: number
  eligible: boolean
  eligibilityText: string
}

const normalizePlatform = (platform?: string | null) =>
  platform === 'claude' || platform === 'anthropic'
    ? 'anthropic'
    : platform === 'openai' || platform === 'gpt'
      ? 'openai'
      : 'unknown'

function endpointPlatform(endpoint: ApiEndpoint) {
  if (endpoint.kind === 'claude' || endpoint.protocol === 'anthropic')
    return 'anthropic' as const
  if (endpoint.kind === 'openai' || endpoint.protocol === 'openai')
    return 'openai' as const
  return 'unknown' as const
}

function vmStatus(vm: Vm, notChecked: string, noCredentials: string) {
  const key = vm.availability?.key
  if (!vm.has_token && !vm.has_refresh)
    return { status: 'bad' as const, text: noCredentials }
  if (key === 'ok' || vm.availability?.usable)
    return { status: 'ok' as const, text: vm.availability?.text || notChecked }
  if (key === 'quota' || key === 'cool' || key === 'drain' || key === 'rest')
    return {
      status: 'limited' as const,
      text: vm.availability?.text || notChecked,
    }
  return {
    status: 'bad' as const,
    text: vm.availability?.text || notChecked,
  }
}

function endpointStatus(
  endpoint: ApiEndpoint,
  notChecked: string,
  available: string
) {
  if (endpoint.disabled) return { status: 'bad' as const, text: notChecked }
  const keys = endpoint.api_key_entries || []
  const ready = keys.filter(
    (entry) => !entry.disabled && !entry.cooldown_until
  ).length
  if (ready > 0) return { status: 'ok' as const, text: available }
  if (keys.length) return { status: 'limited' as const, text: notChecked }
  return { status: 'bad' as const, text: notChecked }
}

export function ResourcePicker({
  group,
  kind,
  onKindChange,
  value,
  onChange,
  priorities,
  onPriorityChange,
  vms,
  endpoints,
  staff,
  loading,
  error,
}: ResourcePickerProps) {
  const { t } = useTranslation('groups')
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<
    'compatible' | 'all' | 'anthropic' | 'openai'
  >('compatible')
  const [membership, setMembership] = useState<Membership>('all')
  const [status, setStatus] = useState<FilterStatus>('all')

  const existingKind = groupBackendKind(group.resources)
  const kindLocked = (next: ResourceKind) =>
    Boolean(existingKind && existingKind !== next)
  const currentGroupId = group.id
  const normalizedGroupPlatform = normalizePlatform(group.platform)

  useEffect(() => {
    setSearch('')
    setPlatform('compatible')
    setMembership('all')
    setStatus('all')
  }, [kind])

  const rows = useMemo<ResourceRow[]>(() => {
    const source: ResourceRow[] =
      kind === 'vm'
        ? vms.map((vm) => {
            const vmPlatform = normalizePlatform(vm.platform)
            const vmState = vmStatus(
              vm,
              t('groups:notChecked'),
              t('groups:noCredentials')
            )
            const groups = (vm.groups || []).map((item) => ({
              id: item.id,
              name: item.name,
            }))
            if (
              value.includes(vm.id) &&
              !groups.some((item) => item.id === currentGroupId)
            )
              groups.push({ id: currentGroupId, name: group.name })
            const compatible =
              group.platform === 'mixed' ||
              normalizedGroupPlatform === 'unknown' ||
              vmPlatform === normalizedGroupPlatform
            return {
              id: vm.id,
              name: vm.name || vm.id,
              sub: [vm.email, vm.id].filter(Boolean).join(' · '),
              kind: 'vm',
              platform: vmPlatform,
              status: vmState.status,
              statusText: vmState.text,
              groups,
              priority: priorities[vm.id] ?? 50,
              eligible: compatible,
              eligibilityText: compatible
                ? groups.some((item) => item.id === currentGroupId)
                  ? t('groups:alreadyInCurrentGroup')
                  : t('groups:canJoinCurrentGroup')
                : t('groups:platformMismatch'),
            }
          })
        : endpoints.map((endpoint) => {
            const endpointState = endpointStatus(
              endpoint,
              t('groups:notChecked'),
              t('groups:resourceAvailable')
            )
            const groups = (endpoint.groups || []).map((item) => ({
              id: item.id,
              name: item.name,
            }))
            if (
              value.includes(endpoint.id) &&
              !groups.some((item) => item.id === currentGroupId)
            )
              groups.push({ id: currentGroupId, name: group.name })
            return {
              id: endpoint.id,
              name: endpoint.name || endpoint.id,
              sub: [
                endpoint.base_url || t('groups:missingEndpoint'),
                endpoint.id,
              ]
                .filter(Boolean)
                .join(' · '),
              kind: 'api_endpoint',
              platform: endpointPlatform(endpoint),
              status: endpointState.status,
              statusText: endpointState.text,
              groups,
              eligible: true,
              eligibilityText: groups.some((item) => item.id === currentGroupId)
                ? t('groups:alreadyInCurrentGroup')
                : t('groups:canJoinCurrentGroup'),
            }
          })

    const query = search.trim().toLowerCase()
    return source
      .filter((row) => {
        if (
          query &&
          !`${row.name} ${row.sub} ${row.id}`.toLowerCase().includes(query)
        )
          return false
        if (
          platform !== 'all' &&
          platform !== 'compatible' &&
          row.platform !== platform
        )
          return false
        if (platform === 'compatible' && !row.eligible) return false
        if (status !== 'all' && row.status !== status) return false
        const current = row.groups.some((item) => item.id === currentGroupId)
        if (membership === 'current' && !current) return false
        if (membership === 'other' && (current || !row.groups.length))
          return false
        if (membership === 'none' && row.groups.length) return false
        return true
      })
      .sort((left, right) => {
        const selected =
          Number(value.includes(right.id)) - Number(value.includes(left.id))
        if (selected) return selected
        return left.name.localeCompare(right.name, undefined, { numeric: true })
      })
  }, [
    currentGroupId,
    endpoints,
    group.platform,
    kind,
    membership,
    normalizedGroupPlatform,
    priorities,
    search,
    status,
    t,
    value,
    vms,
    platform,
  ])

  const visibleEligibleIds = rows
    .filter((row) => row.eligible)
    .map((row) => row.id)
  const allVisibleSelected =
    visibleEligibleIds.length > 0 &&
    visibleEligibleIds.every((id) => value.includes(id))

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...value, id] : value.filter((item) => item !== id))
  }

  function selectVisible(checked: boolean) {
    if (checked) {
      onChange([...new Set([...value, ...visibleEligibleIds])])
    } else {
      onChange(value.filter((id) => !visibleEligibleIds.includes(id)))
    }
  }

  return (
    <div className='space-y-4'>
      <div
        className='flex flex-wrap gap-2'
        role='tablist'
        aria-label={t('groups:resourceType')}
      >
        <Button
          type='button'
          variant={kind === 'vm' ? 'default' : 'outline'}
          role='tab'
          aria-selected={kind === 'vm'}
          disabled={kindLocked('vm')}
          title={kindLocked('vm') ? t('groups:backendLocked') : undefined}
          onClick={() => onKindChange('vm')}
        >
          {t('groups:vmSlots')} ({vms.length})
        </Button>
        {staff ? (
          <Button
            type='button'
            variant={kind === 'api_endpoint' ? 'default' : 'outline'}
            role='tab'
            aria-selected={kind === 'api_endpoint'}
            disabled={kindLocked('api_endpoint')}
            title={
              kindLocked('api_endpoint') ? t('groups:backendLocked') : undefined
            }
            onClick={() => onKindChange('api_endpoint')}
          >
            {t('groups:apiEndpoints')} ({endpoints.length})
          </Button>
        ) : null}
      </div>

      <div className='flex flex-wrap gap-2'>
        <Input
          className='min-w-56 flex-1'
          aria-label={t('groups:searchResources')}
          placeholder={
            kind === 'vm'
              ? t('groups:resourcePlaceholder')
              : t('groups:searchApiPlaceholder')
          }
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label={t('groups:resourcePlatform')}
          className='h-9 rounded border bg-background px-2'
          value={platform}
          onChange={(event) =>
            setPlatform(event.target.value as typeof platform)
          }
        >
          <option value='compatible'>{t('groups:compatiblePlatform')}</option>
          <option value='all'>{t('groups:allPlatforms')}</option>
          <option value='anthropic'>Claude</option>
          <option value='openai'>GPT</option>
        </select>
        <select
          aria-label={t('groups:groupMembership')}
          className='h-9 rounded border bg-background px-2'
          value={membership}
          onChange={(event) => setMembership(event.target.value as Membership)}
        >
          <option value='all'>{t('groups:allMemberships')}</option>
          <option value='current'>{t('groups:inCurrentGroup')}</option>
          <option value='other'>{t('groups:inOtherGroups')}</option>
          <option value='none'>{t('groups:ungrouped')}</option>
        </select>
        <select
          aria-label={t('groups:resourceStatus')}
          className='h-9 rounded border bg-background px-2'
          value={status}
          onChange={(event) => setStatus(event.target.value as FilterStatus)}
        >
          <option value='all'>{t('groups:allResourceStatuses')}</option>
          <option value='ok'>{t('groups:resourceAvailable')}</option>
          <option value='limited'>{t('groups:resourceLimited')}</option>
          <option value='bad'>{t('groups:resourceUnavailable')}</option>
        </select>
      </div>

      <div className='flex items-center justify-between gap-2 text-xs text-muted-foreground'>
        <span aria-live='polite'>
          {t('groups:resourceVisibleCount', { count: rows.length })} ·{' '}
          {t('groups:selectedResourceCount', { count: value.length })}
        </span>
        <div className='flex gap-1'>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => selectVisible(true)}
          >
            {t('groups:selectVisible')}
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            onClick={() => onChange([])}
          >
            {t('groups:clearSelection')}
          </Button>
        </div>
      </div>

      <div className='max-h-[50svh] space-y-2 overflow-y-auto'>
        {loading ? (
          <p className='rounded border border-dashed p-6 text-center text-sm text-muted-foreground'>
            {t('groups:loadingResources')}
          </p>
        ) : error ? (
          <p
            role='alert'
            className='rounded border border-dashed p-6 text-sm text-destructive'
          >
            {error.message}
          </p>
        ) : rows.length ? (
          <>
            <label className='flex items-center gap-2 px-1 text-xs text-muted-foreground'>
              <input
                type='checkbox'
                checked={allVisibleSelected}
                onChange={(event) => selectVisible(event.target.checked)}
              />
              {t('groups:selectVisible')}
            </label>
            {rows.map((row) => {
              const selected = value.includes(row.id)
              return (
                <label
                  key={row.id}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                    selected && 'border-primary bg-primary/5',
                    !row.eligible && 'opacity-60'
                  )}
                >
                  <input
                    className='mt-1 size-4 accent-primary'
                    type='checkbox'
                    checked={selected}
                    disabled={!row.eligible}
                    onChange={(event) => toggle(row.id, event.target.checked)}
                    aria-label={t('groups:selectResource', { name: row.name })}
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='flex flex-wrap items-center gap-2'>
                      <b className='truncate'>{row.name}</b>
                      <Badge variant='outline'>
                        {row.kind === 'vm'
                          ? t('groups:vmSlot')
                          : t('groups:apiEndpoint')}
                      </Badge>
                      <Badge variant='secondary'>
                        {row.platform === 'anthropic'
                          ? 'Claude'
                          : row.platform === 'openai'
                            ? 'GPT'
                            : t('groups:unknownPlatform')}
                      </Badge>
                    </span>
                    <span className='mt-1 block truncate font-mono text-[11px] text-muted-foreground'>
                      {row.sub}
                    </span>
                    <span className='mt-2 flex flex-wrap items-center gap-1'>
                      {row.groups.length ? (
                        row.groups.map((item) => (
                          <Badge
                            key={item.id}
                            variant={
                              item.id === currentGroupId ? 'default' : 'outline'
                            }
                          >
                            {item.name}
                            {item.id === currentGroupId
                              ? ` · ${t('groups:currentGroup')}`
                              : ''}
                          </Badge>
                        ))
                      ) : (
                        <span className='text-xs text-amber-600'>
                          {t('groups:ungrouped')}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className='flex shrink-0 flex-col items-end gap-2'>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px]',
                        row.status === 'ok' &&
                          'bg-[var(--status-ok-bg)] text-[var(--status-ok)]',
                        row.status === 'limited' &&
                          'bg-[var(--status-caution-bg)] text-[var(--status-caution)]',
                        row.status === 'bad' &&
                          'bg-destructive/10 text-destructive'
                      )}
                    >
                      {row.statusText}
                    </span>
                    <span
                      className={cn(
                        'max-w-28 text-right text-[11px]',
                        row.eligible
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                      )}
                    >
                      {row.eligibilityText}
                    </span>
                    {row.kind === 'vm' ? (
                      <Input
                        aria-label={t('groups:priorityLabel', {
                          name: row.name,
                        })}
                        className='h-8 w-20'
                        type='number'
                        min='0'
                        max='10000'
                        value={priorities[row.id] ?? 50}
                        disabled={!selected}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          onPriorityChange(row.id, Number(event.target.value))
                        }
                      />
                    ) : null}
                  </span>
                </label>
              )
            })}
          </>
        ) : (
          <p className='rounded border border-dashed p-6 text-center text-sm text-muted-foreground'>
            {kind === 'vm'
              ? t('groups:noVms')
              : t('groups:noMatchingEndpoints')}
          </p>
        )}
      </div>

      <p className='text-xs leading-5 text-muted-foreground'>
        {kind === 'vm' ? t('groups:priorityHelp') : t('groups:apiResourceHelp')}
      </p>
    </div>
  )
}

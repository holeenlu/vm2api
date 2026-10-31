import { useEffect, useRef, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CredentialPanel } from '@/features/vm/credential-panel'
import type { Resource, Vendor } from './portal-model'
import { AccountProxyInput } from './proxy-input'

type Group = {
  id: number
  name: string
  platform: string
  supported_platforms?: string[]
}
export function visibleAccountGroups(
  vendor: Vendor,
  groups: Group[],
  platform: string
) {
  const grants = new Set((vendor.groups || []).map((value) => String(value)))
  return groups.filter(
    (group) =>
      group.supported_platforms?.includes(platform) &&
      (!grants.size ||
        grants.has(String(group.id)) ||
        grants.has(String(group.name)))
  )
}
export function AccountCreateForm({
  vendor,
  proxies,
  groups,
  onClose,
  onBusyChange,
  catalogLoading = false,
  catalogError = false,
  onChanged,
}: {
  vendor: Vendor
  proxies: Resource[]
  groups: Group[]
  onClose: () => void
  onBusyChange: (busy: boolean) => void
  catalogLoading?: boolean
  catalogError?: boolean
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('vendor')
  const allows = (platform: string) =>
    vendor.effective_platforms
      ? vendor.effective_platforms.includes(platform)
      : !vendor.platforms?.length ||
        vendor.platforms.some(
          (p) =>
            (p === 'claude' ? 'anthropic' : p === 'codex' ? 'openai' : p) ===
            platform
        )
  const [chosenPlatform, setPlatform] = useState(
    allows('anthropic') ? 'anthropic' : 'openai'
  )
  const platform = allows(chosenPlatform)
    ? chosenPlatform
    : allows('anthropic')
      ? 'anthropic'
      : allows('openai')
        ? 'openai'
        : ''
  const [name, setName] = useState('')
  const [proxy, setProxy] = useState({ proxy_id: '', proxy_endpoint: '' })
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [created] = useState(false)
  const [draftId, setDraftId] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const key = useRef(crypto.randomUUID())
  const draftRef = useRef('')
  const pending = useRef<Promise<string> | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const visibleGroups = visibleAccountGroups(vendor, groups, platform)
  const vm: Vm = {
    id: '',
    platform,
    family: platform === 'openai' ? 'codex' : 'claude',
    name,
    can_import_credential: true,
  }
  async function prepareDraft(authorizationKind: string): Promise<string> {
    if (draftRef.current) return draftRef.current
    if (pending.current) return pending.current
    if (!proxy.proxy_id && !proxy.proxy_endpoint.trim()) {
      const message = t('proxyRequiredForBoot')
      setError(message)
      throw new Error(message)
    }
    if (!visibleGroups.length) {
      const message = t('noAvailableGroup')
      setError(message)
      throw new Error(message)
    }
    setPreparing(true)
    onBusyChange(true)
    setError('')
    const task = (async () => {
      const result = await api<{
        draft: { id: string }
      }>('/api/vendor/account-drafts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          platform,
          authorization_kind: authorizationKind,
          ...proxy,
          group_ids: groupIds,
          idempotency_key: key.current,
        }),
      })
      if (!alive.current) throw new Error(t('operationCancelled'))
      draftRef.current = result.draft.id
      setDraftId(result.draft.id)
      return result.draft.id
    })()
    pending.current = task
    try {
      return await task
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : t('saveFailed'))
      throw e
    } finally {
      pending.current = null
      if (alive.current) {
        setPreparing(false)
        onBusyChange(false)
      }
    }
  }
  return (
    <div className='space-y-5'>
      {catalogError && (
        <p role='alert' className='text-sm text-destructive'>
          {t('catalogLoadFailed')}
        </p>
      )}
      <fieldset
        disabled={created || preparing || catalogLoading || catalogError}
        className='space-y-4 disabled:opacity-70'
      >
        <label className='grid gap-2 text-sm font-medium'>
          {t('platform')}
          <select
            aria-label={t('platform')}
            className='h-10 rounded-lg border bg-background px-3'
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value)
              setGroupIds([])
              setError('')
            }}
          >
            {allows('anthropic') && (
              <option value='anthropic'>Anthropic</option>
            )}
            {allows('openai') && <option value='openai'>OpenAI</option>}
          </select>
        </label>
        <label className='grid gap-2 text-sm font-medium'>
          {t('accountName')}
          <Input
            maxLength={160}
            placeholder={t(
              'vm:createVmForm.leaveBlankForAnAutomaticIDSuchAsVm'
            )}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className='grid gap-2 text-sm font-medium'>
          <p>{t('proxy')}</p>
          <AccountProxyInput
            endpoint={proxy.proxy_endpoint}
            proxyId={proxy.proxy_id}
            proxies={proxies}
            onChange={setProxy}
          />
        </div>
        <fieldset className='space-y-2 rounded-lg border p-3'>
          <legend className='px-1 text-sm font-medium'>{t('groups')}</legend>
          <div className='grid gap-2 sm:grid-cols-2'>
            {visibleGroups.map((g) => (
              <label key={g.id} className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={groupIds.includes(g.id)}
                  onChange={(e) =>
                    setGroupIds(
                      e.target.checked
                        ? [...groupIds, g.id]
                        : groupIds.filter((id) => id !== g.id)
                    )
                  }
                />
                {g.name}
              </label>
            ))}
          </div>
          <p className='text-xs text-muted-foreground'>
            {t(
              catalogLoading
                ? 'loading'
                : visibleGroups.length
                  ? 'groupsHelp'
                  : 'noAvailableGroup'
            )}
          </p>
        </fieldset>
      </fieldset>
      <fieldset
        disabled={
          catalogLoading || catalogError || preparing || !visibleGroups.length
        }
        className='space-y-3 border-t pt-4'
        aria-label={t('authMethod')}
      >
        <h3 className='text-sm font-semibold'>{t('authMethod')}</h3>
        <p className='text-xs text-muted-foreground'>
          {t(
            created ? 'accountCreatedForAuth' : 'accountCreateOnAuthorization'
          )}
        </p>
        <CredentialPanel
          key={platform}
          vm={vm}
          draftId={draftId}
          showConvert={false}
          prepareDraft={prepareDraft}
          onCommitted={async () => {
            await onChanged()
            onClose()
          }}
        />
      </fieldset>
      {error && (
        <p role='alert' className='text-sm text-destructive'>
          {error}
        </p>
      )}
      <div className='flex justify-end'>
        <Button
          type='button'
          variant='outline'
          disabled={preparing}
          onClick={onClose}
        >
          {t(created ? 'finishLater' : 'cancel')}
        </Button>
      </div>
    </div>
  )
}

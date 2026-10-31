import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  accountAuthorizationOptions,
  type AccountGroup,
} from '@/features/vendor/account-create-form'
import type { Resource } from '@/features/vendor/portal-model'
import { AccountProxyInput } from '@/features/vendor/proxy-input'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { ROOT, selectClass, type Supplier } from './model'

type CreatedAuthorization = {
  vm: Vm
  kind: 'oauth' | 'setup-token' | 'apikey'
  method: 'link' | 'session'
  codexMode?: 'oauth' | 'json'
}

export function AdminAccountCreateForm({
  suppliers,
  initialVendor,
  close,
  saved,
}: {
  suppliers: Supplier[]
  initialVendor: string
  close: () => void
  saved: () => Promise<void>
}) {
  const { t: tVendor } = useTranslation('vendor')
  const { t } = useTranslation('supplierAdmin')
  const [vendorId, setVendorId] = useState(
    initialVendor === 'all' ? '' : initialVendor
  )
  const [platform, setPlatform] = useState<'anthropic' | 'openai'>('anthropic')
  const [name, setName] = useState('')
  const [proxy, setProxy] = useState({ proxy_id: '', proxy_endpoint: '' })
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [auth, setAuth] = useState<string>('claude_oauth')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdAuth, setCreatedAuth] = useState<CreatedAuthorization | null>(
    null
  )

  const supplier = suppliers.find((item) => item.id === vendorId)
  const allows = (candidate: string) =>
    !supplier ||
    (supplier.effective_platforms
      ? supplier.effective_platforms.includes(candidate)
      : !supplier.platforms?.length ||
        supplier.platforms.some(
          (value) =>
            (value === 'claude'
              ? 'anthropic'
              : value === 'codex'
                ? 'openai'
                : value) === candidate
        ))
  const currentPlatform = allows(platform)
    ? platform
    : allows('anthropic')
      ? 'anthropic'
      : 'openai'
  const groups = useQuery({
    queryKey: ['supplier-admin', 'account-groups', vendorId, currentPlatform],
    queryFn: () =>
      api<{ items: AccountGroup[] }>(
        `${ROOT}/account-groups?vendor_id=${encodeURIComponent(vendorId)}&platform=${encodeURIComponent(currentPlatform)}`
      ),
    enabled: !!vendorId,
  })
  const proxies = useQuery({
    queryKey: ['supplier-admin', 'create-proxies', vendorId],
    queryFn: () =>
      api<Resource[]>(
        `${ROOT}/proxies?vendor_id=${encodeURIComponent(vendorId)}`
      ),
    enabled: !!vendorId,
  })
  const visibleGroups = useMemo(
    () => groups.data?.items || [],
    [groups.data?.items]
  )
  const authOptions = accountAuthorizationOptions[currentPlatform]

  useEffect(() => {
    if (!allows(platform) && allows('anthropic')) setPlatform('anthropic')
    if (!allows(platform) && !allows('anthropic') && allows('openai'))
      setPlatform('openai')
  }, [platform, supplier])

  useEffect(() => {
    if (!authOptions.some((option) => option === auth)) setAuth(authOptions[0])
  }, [authOptions, auth])

  const setSelectedPlatform = (value: 'anthropic' | 'openai') => {
    setPlatform(value)
    setGroupIds([])
    setAuth(value === 'anthropic' ? 'claude_oauth' : 'codex_oauth')
    setError('')
  }

  const submit = async () => {
    if (!vendorId) return
    if (!proxy.proxy_id && !proxy.proxy_endpoint.trim()) {
      setError(tVendor('proxyRequiredForBoot'))
      return
    }
    if (!groupIds.length) {
      setError(tVendor('groupsRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api<{
        account: Resource
        vm: Resource
      }>(`${ROOT}/accounts?vendor_id=${encodeURIComponent(vendorId)}`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          platform: currentPlatform,
          authorization_kind: auth,
          ...proxy,
          group_ids: groupIds,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      await saved()
      const runtimeVmId = String(
        (result.vm.config as { runtime_vm_id?: string }).runtime_vm_id || ''
      )
      if (!runtimeVmId) throw new Error(tVendor('accountVmMissing'))
      setCreatedAuth({
        vm: {
          id: runtimeVmId,
          name: result.account.name,
          platform: currentPlatform,
          family: currentPlatform === 'openai' ? 'codex' : 'claude',
          can_import_credential: true,
        },
        kind:
          currentPlatform === 'openai'
            ? 'oauth'
            : auth === 'claude_setup_token'
              ? 'setup-token'
              : auth === 'claude_console'
                ? 'apikey'
                : 'oauth',
        method: auth === 'claude_setup_token' ? 'session' : 'link',
        ...(currentPlatform === 'openai'
          ? { codexMode: auth === 'codex_account_file' ? 'json' : 'oauth' }
          : {}),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {createdAuth ? tVendor('authorizeAccount') : t('addAccount')}
          </DialogTitle>
          <DialogDescription>
            {createdAuth
              ? tVendor('authorizeAccountDescription')
              : tVendor('accountDialogDescription')}
          </DialogDescription>
        </DialogHeader>
        {createdAuth ? (
          <div className='space-y-4'>
            <CredentialPanel
              vm={createdAuth.vm}
              showConvert={false}
              initialKind={createdAuth.kind}
              initialMethod={createdAuth.method}
              initialCodexMode={createdAuth.codexMode}
              onCommitted={async () => {
                await saved()
                close()
              }}
            />
            <Button type='button' variant='outline' onClick={close}>
              {tVendor('finishLater')}
            </Button>
          </div>
        ) : (
          <div className='space-y-5'>
            <fieldset disabled={busy} className='space-y-4 disabled:opacity-70'>
              <label className='grid gap-2 text-sm font-medium'>
                {t('supplier')}
                <select
                  required
                  className={selectClass}
                  value={vendorId}
                  onChange={(e) => {
                    setVendorId(e.target.value)
                    setProxy({ proxy_id: '', proxy_endpoint: '' })
                    setGroupIds([])
                    setError('')
                  }}
                >
                  <option value=''>{t('selectSupplier')}</option>
                  {suppliers
                    .filter((item) => item.status === 'active')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className='grid gap-2 text-sm font-medium'>
                {tVendor('platform')}
                <select
                  className={selectClass}
                  value={currentPlatform}
                  onChange={(e) =>
                    setSelectedPlatform(
                      e.target.value as 'anthropic' | 'openai'
                    )
                  }
                >
                  {allows('anthropic') && (
                    <option value='anthropic'>Anthropic</option>
                  )}
                  {allows('openai') && <option value='openai'>OpenAI</option>}
                </select>
              </label>
              <label className='grid gap-2 text-sm font-medium'>
                {tVendor('accountName')}
                <Input
                  maxLength={160}
                  placeholder={tVendor(
                    'vm:createVmForm.leaveBlankForAnAutomaticIDSuchAsVm'
                  )}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className='grid gap-2 text-sm font-medium'>
                {tVendor('proxy')}
                <AccountProxyInput
                  endpoint={proxy.proxy_endpoint}
                  proxyId={proxy.proxy_id}
                  proxies={proxies.data || []}
                  onChange={setProxy}
                />
              </div>
              <fieldset className='space-y-2 rounded-lg border p-3'>
                <legend className='px-1 text-sm font-medium'>
                  {tVendor('groups')}
                </legend>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {visibleGroups.map((group) => (
                    <label
                      key={group.id}
                      className='flex items-center gap-2 text-sm'
                    >
                      <input
                        type='checkbox'
                        checked={groupIds.includes(group.id)}
                        onChange={(e) =>
                          setGroupIds(
                            e.target.checked
                              ? [...groupIds, group.id]
                              : groupIds.filter((id) => id !== group.id)
                          )
                        }
                      />
                      {group.name}
                    </label>
                  ))}
                </div>
                {groups.isPending ||
                !visibleGroups.length ||
                !groupIds.length ? (
                  <p className='text-xs text-muted-foreground'>
                    {groups.isPending
                      ? tVendor('loading')
                      : visibleGroups.length
                        ? tVendor('groupsRequired')
                        : tVendor('noAvailableGroup')}
                  </p>
                ) : null}
              </fieldset>
              <label className='grid gap-2 text-sm font-medium'>
                {tVendor('authMethod')}
                <select
                  className={selectClass}
                  value={auth}
                  onChange={(e) => setAuth(e.target.value)}
                >
                  {authOptions.map((option) => (
                    <option key={option} value={option}>
                      {t(`auth_${option}`)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
            {error && (
              <p role='alert' className='text-sm text-destructive'>
                {error}
              </p>
            )}
            <div className='flex justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                onClick={close}
                disabled={busy}
              >
                {tVendor('cancel')}
              </Button>
              <Button
                type='button'
                onClick={() => void submit()}
                disabled={
                  busy || !vendorId || !visibleGroups.length || !groupIds.length
                }
              >
                {tVendor('create')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { CommercialGroup } from '@/features/groups/queries'
import {
  ROOT,
  selectClass,
  type Supplier,
  type SupplierResource,
} from './model'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className='grid gap-2 text-sm'>
      {label}
      {children}
    </label>
  )
}
export function SupplierEditor({
  supplier,
  groups,
  close,
  saved,
}: {
  supplier?: Supplier
  groups: CommercialGroup[]
  close: () => void
  saved: () => Promise<void>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [form, setForm] = useState({
    name: supplier?.name || '',
    username: '',
    password: '',
    email: supplier?.email || '',
    external_code: supplier?.external_code || '',
    status: supplier?.status || 'active',
    groups: supplier?.groups || [],
    platforms: supplier?.platforms || ['anthropic', 'openai'],
    account_limit: supplier?.account_limit || 0,
    proxy_limit: supplier?.proxy_limit || 0,
    child_limit: supplier?.child_limit || 0,
    contact_name: supplier?.contact_name || '',
    settlement_email: supplier?.settlement_email || '',
    binance_id: supplier?.binance_id || '',
    default_price_cny_per_usd: supplier?.default_price_cny_per_usd ?? 1.6,
    fx_cny_per_usdt: supplier?.fx_cny_per_usdt ?? 6.7,
    default_multiplier: supplier?.default_multiplier ?? 1,
    create_child:
      supplier?.capabilities.includes('vendor.create_child') || false,
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const { username, password, external_code, ...editable } = form
      const body = supplier
        ? editable
        : {
            ...form,
            external_code: external_code || username,
            capabilities: [
              'vendor.resource.manage',
              'vendor.vm.create',
              'vendor.usage.read',
              'vendor.settlement.read',
              ...(form.create_child ? ['vendor.create_child'] : []),
            ],
          }
      await api(supplier ? `${ROOT}/${supplier.id}` : ROOT, {
        method: supplier ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      })
      await saved()
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const text = (
    key:
      | 'name'
      | 'username'
      | 'password'
      | 'email'
      | 'external_code'
      | 'contact_name'
      | 'settlement_email'
      | 'binance_id',
    label: string,
    type = 'text'
  ) => (
    <Field label={t(label)}>
      <Input
        type={type}
        value={form[key]}
        autoComplete={key === 'password' ? 'new-password' : 'off'}
        required={['name', 'username', 'password', 'email'].includes(key)}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </Field>
  )
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
            {t(supplier ? 'editSupplier' : 'addSupplier')}
          </DialogTitle>
          <DialogDescription>{t('supplierEditorHint')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className='space-y-5'
        >
          <div className='grid gap-4 sm:grid-cols-2'>
            {text('name', 'name')}
            {text('email', 'email', 'email')}
            {!supplier && (
              <>
                {text('username', 'username')}
                {text('password', 'password', 'password')}
                {text('external_code', 'externalCode')}
              </>
            )}
            {supplier && (
              <Field label={t('status')}>
                <select
                  className={selectClass}
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {['active', 'disabled', 'archived'].map((s) => (
                    <option value={s} key={s}>
                      {t(`status_${s}`)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {text('contact_name', 'contact')}
            {text('settlement_email', 'settlementEmail', 'email')}
            {text('binance_id', 'binance')}
          </div>
          <fieldset className='space-y-3 rounded-lg border p-4'>
            <legend className='px-2 text-sm'>{t('supplyPolicy')}</legend>
            <div className='flex gap-5'>
              {['anthropic', 'openai'].map((p) => (
                <label key={p} className='flex gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={form.platforms.includes(p)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        platforms: e.target.checked
                          ? [...form.platforms, p]
                          : form.platforms.filter((v) => v !== p),
                      })
                    }
                  />
                  {p === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                </label>
              ))}
            </div>
            <div className='flex flex-wrap gap-4'>
              {groups.map((g) => (
                <label key={g.id} className='flex gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={form.groups.includes(String(g.id))}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        groups: e.target.checked
                          ? [...form.groups, String(g.id)]
                          : form.groups.filter((v) => v !== String(g.id)),
                      })
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
            <div className='grid gap-3 sm:grid-cols-3'>
              {(['account_limit', 'proxy_limit', 'child_limit'] as const).map(
                (k) => (
                  <Field key={k} label={t(k)}>
                    <Input
                      type='number'
                      min='0'
                      step='1'
                      value={form[k]}
                      onChange={(e) =>
                        setForm({ ...form, [k]: Number(e.target.value) })
                      }
                    />
                  </Field>
                )
              )}
            </div>
            <p className='text-xs text-muted-foreground'>{t('limitHint')}</p>
            {supplier?.tier !== 2 && (
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={form.create_child}
                  onChange={(e) =>
                    setForm({ ...form, create_child: e.target.checked })
                  }
                />
                {t('allowChildren')}
              </label>
            )}
          </fieldset>
          <fieldset className='grid gap-4 rounded-lg border p-4 sm:grid-cols-3'>
            <legend className='px-2 text-sm'>{t('settlementProfile')}</legend>
            {(
              [
                'default_price_cny_per_usd',
                'fx_cny_per_usdt',
                'default_multiplier',
              ] as const
            ).map((k) => (
              <Field key={k} label={t(k)}>
                <Input
                  type='number'
                  min='0.000001'
                  step='any'
                  required
                  value={form[k]}
                  onChange={(e) =>
                    setForm({ ...form, [k]: Number(e.target.value) })
                  }
                />
              </Field>
            ))}
          </fieldset>
          {error && (
            <p role='alert' className='text-sm text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={busy}
              onClick={close}
            >
              {t('cancel')}
            </Button>
            <Button disabled={busy} type='submit'>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
export function ResourceEditor({
  kind,
  suppliers,
  initialVendor,
  close,
  saved,
}: {
  kind: 'accounts' | 'proxies'
  suppliers: Supplier[]
  initialVendor: string
  close: () => void
  saved: () => Promise<void>
}) {
  const { t } = useTranslation('supplierAdmin')
  const [vendorId, setVendorId] = useState(
      initialVendor === 'all' ? '' : initialVendor
    ),
    [name, setName] = useState(''),
    [endpoint, setEndpoint] = useState(''),
    [auth, setAuth] = useState('claude_oauth'),
    [proxyId, setProxyId] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [key] = useState(() => crypto.randomUUID())
  const proxies = useQuery({
    queryKey: ['supplier-admin', 'create-proxies', vendorId],
    queryFn: () =>
      api<SupplierResource[]>(
        `${ROOT}/proxies?vendor_id=${encodeURIComponent(vendorId)}`
      ),
    enabled: kind === 'accounts' && !!vendorId,
  })
  const submit = async () => {
    setError('')
    setBusy(true)
    try {
      const body =
        kind === 'accounts'
          ? {
              name,
              authorization_kind: auth,
              platform: auth.startsWith('codex') ? 'openai' : 'anthropic',
              proxy_id: proxyId,
              idempotency_key: key,
            }
          : { name, config: { endpoint } }
      await api(`${ROOT}/${kind}?vendor_id=${encodeURIComponent(vendorId)}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      await saved()
      close()
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(kind === 'accounts' ? 'addAccount' : 'addProxy')}
          </DialogTitle>
          <DialogDescription>
            {t(
              kind === 'accounts' ? 'accountCreationHint' : 'proxyCreationHint'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4'
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label={t('supplier')}>
            <select
              className={selectClass}
              required
              value={vendorId}
              onChange={(e) => {
                setVendorId(e.target.value)
                setProxyId('')
              }}
            >
              <option value=''>{t('selectSupplier')}</option>
              {suppliers
                .filter((v) => v.status === 'active')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('name')}>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {kind === 'accounts' ? (
            <>
              <Field label={t('authorization')}>
                <select
                  className={selectClass}
                  value={auth}
                  onChange={(e) => setAuth(e.target.value)}
                >
                  {[
                    'claude_oauth',
                    'claude_setup_token',
                    'claude_console',
                    'codex_oauth',
                    'codex_account_file',
                  ].map((a) => (
                    <option value={a} key={a}>
                      {t(`auth_${a}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('proxy')}>
                <select
                  required
                  className={selectClass}
                  value={proxyId}
                  onChange={(e) => setProxyId(e.target.value)}
                >
                  <option value=''>{t('selectProxy')}</option>
                  {proxies.data
                    ?.filter(
                      (p) => p.vendor_id === vendorId && p.status === 'active'
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </Field>
              {proxies.error && (
                <p role='alert' className='text-destructive'>
                  {proxies.error.message}
                </p>
              )}
            </>
          ) : (
            <Field label={t('endpoint')}>
              <Input
                required
                placeholder='socks5://host:1080'
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Field>
          )}
          {error && (
            <p role='alert' className='text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={close}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button disabled={busy || !vendorId} type='submit'>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

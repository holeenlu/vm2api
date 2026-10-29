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
import { Textarea } from '@/components/ui/textarea'
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
    username: '',
    password: '',
    status: supplier?.status || 'active',
    groups: supplier?.groups || [],
    platforms: supplier?.platforms || ['anthropic', 'openai'],
    account_limit: supplier?.account_limit || 0,
    proxy_limit: supplier?.proxy_limit || 0,
    child_limit: supplier?.child_limit || 0,
    binance_id: supplier?.binance_id || '',
    remark: supplier?.remark || '',
    group_prices: {
      anthropic: Number(
        supplier?.group_prices?.anthropic ??
          supplier?.default_price_cny_per_usd ??
          1.6
      ),
      openai: Number(
        supplier?.group_prices?.openai ??
          supplier?.default_price_cny_per_usd ??
          1.6
      ),
    },
    fx_cny_per_usdt: supplier?.fx_cny_per_usdt ?? 6.7,
    default_multiplier: supplier?.default_multiplier ?? 1,
    settlement_pay:
      supplier?.capabilities.includes('vendor.settlement.pay') || false,
    create_child:
      supplier?.capabilities.includes('vendor.create_child') || false,
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const { username, password, group_prices, ...fields } = form
      const editable = {
        ...fields,
        group_prices: Object.fromEntries(
          Object.entries(group_prices).filter(([platform]) =>
            form.platforms.includes(platform)
          )
        ),
      }
      const body = supplier
        ? editable
        : {
            ...editable,
            username,
            password,
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
    key: 'username' | 'password' | 'binance_id',
    label: string,
    type = 'text'
  ) => (
    <Field label={t(label)}>
      <Input
        type={type}
        value={form[key]}
        autoComplete={key === 'password' ? 'new-password' : 'off'}
        required={key === 'username' || key === 'password'}
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
            {t(
              supplier?.status === 'archived'
                ? 'details'
                : supplier
                  ? 'editSupplier'
                  : 'addSupplier'
            )}
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
          <fieldset
            className='min-w-0 space-y-5'
            disabled={supplier?.status === 'archived'}
          >
            <div className='grid gap-4 sm:grid-cols-2'>
              {!supplier && (
                <>
                  {text('username', 'username')}
                  {text('password', 'password', 'password')}
                </>
              )}
              {supplier && (
                <Field label={t('status')}>
                  <select
                    className={selectClass}
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value })
                    }
                  >
                    {['active', 'disabled', 'archived'].map((s) => (
                      <option value={s} key={s}>
                        {t(`status_${s}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {text('binance_id', 'binance')}
              <Field label={t('remark')}>
                <Textarea
                  value={form.remark}
                  maxLength={1000}
                  rows={2}
                  className='min-h-9 resize-y'
                  onChange={(e) => setForm({ ...form, remark: e.target.value })}
                />
              </Field>
            </div>
            <fieldset className='space-y-5 rounded-lg border p-4'>
              <legend className='px-2 text-sm'>{t('supplyPolicy')}</legend>
              <fieldset className='min-w-0 space-y-2'>
                <legend className='mb-2 text-sm font-medium'>
                  {t('supplyPlatforms')}
                </legend>
                <div className='grid grid-cols-2 gap-2'>
                  {['anthropic', 'openai'].map((p) => (
                    <label
                      key={p}
                      className='flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5'
                    >
                      <input
                        type='checkbox'
                        className='size-4 shrink-0 accent-primary'
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
              </fieldset>
              <fieldset className='min-w-0 space-y-2'>
                <legend className='mb-2 text-sm font-medium'>
                  {t('groups')}
                </legend>
                <div className='grid max-h-48 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2'>
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className='flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5'
                    >
                      <input
                        type='checkbox'
                        className='mt-0.5 size-4 shrink-0 accent-primary'
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
                      <span className='min-w-0 break-words'>{g.name}</span>
                    </label>
                  ))}
                </div>
                {!groups.length && (
                  <p className='text-sm text-muted-foreground'>
                    {t('noGroups')}
                  </p>
                )}
              </fieldset>
              <div className='grid gap-3 border-t pt-4 sm:grid-cols-3'>
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
            {supplier?.tier !== 2 && (
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={form.settlement_pay}
                  onChange={(e) =>
                    setForm({ ...form, settlement_pay: e.target.checked })
                  }
                />
                {t('allowDownstreamPayments')}
              </label>
            )}
            <fieldset className='grid gap-4 rounded-lg border p-4 sm:grid-cols-2'>
              <legend className='px-2 text-sm'>{t('settlementProfile')}</legend>
              {(['anthropic', 'openai'] as const)
                .filter((platform) => form.platforms.includes(platform))
                .map((platform) => (
                  <Field
                    key={platform}
                    label={t(
                      platform === 'anthropic'
                        ? 'claudePurchasePrice'
                        : 'codexPurchasePrice'
                    )}
                  >
                    <Input
                      type='number'
                      min='0.000001'
                      step='any'
                      required
                      value={form.group_prices[platform]}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          group_prices: {
                            ...form.group_prices,
                            [platform]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </Field>
                ))}
              {(['fx_cny_per_usdt', 'default_multiplier'] as const).map((k) => (
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
            {supplier?.status !== 'archived' && (
              <Button disabled={busy} type='submit'>
                {t('save')}
              </Button>
            )}
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

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { FormField as Label } from '@/components/form-field'
import { PageHeader } from '@/components/page-header'
import { apiEndpointsQueryOptions } from '@/features/api-endpoints/queries'
import { meQueryOptions } from '@/features/auth/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { ApiResourcePicker } from './api-resource-picker'
import { ModelWhitelist } from './model-whitelist'
import { groupsQueryOptions, type CommercialGroup } from './queries'
import { GroupUserOverrides } from './user-overrides'

const EMPTY = {
  name: '',
  description: '',
  platform: 'mixed',
  rate_multiplier: 1,
  is_exclusive: false,
  models: [] as string[],
  subscription_type: 'standard',
  daily_limit_usd: 0,
  weekly_limit_usd: 0,
  monthly_limit_usd: 0,
  rpm_limit: 0,
  status: 'active',
}
export function GroupsPage() {
  const { t } = useTranslation('groups')

  const [overrides, setOverrides] = useState<{
    group: CommercialGroup
    field: 'rate_multiplier' | 'rpm_limit'
  } | null>(null)
  const q = useQuery(groupsQueryOptions())
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'super_admin'
  const staff = admin
  const qc = useQueryClient()
  const vms = useQuery({ ...vmsListQueryOptions(), enabled: staff })
  const endpoints = useQuery({
    ...apiEndpointsQueryOptions(),
    enabled: staff,
  })
  const [edit, setEdit] = useState<CommercialGroup | null | undefined>()
  const [form, setForm] = useState(EMPTY)
  const [resourceGroup, setResourceGroup] = useState<CommercialGroup | null>(
    null
  )
  const [resources, setResources] = useState<string[]>([])
  const [kind, setKind] = useState('vm')
  const [priorities, setPriorities] = useState<Record<string, number>>({})
  const mutation = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string
      method: string
      body?: unknown
    }) =>
      api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      setEdit(undefined)
      setResourceGroup(null)
      toast.success(t('groups:saved'))
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const options = (vms.data?.items || []).map((v) => ({
    id: v.id,
    name: v.name || v.id,
    state:
      v.availability?.text ||
      (v.has_token ? t('groups:notChecked') : t('groups:noCredentials')),
  }))
  const [resourceSearch, setResourceSearch] = useState('')
  const [search, setSearch] = useState(''),
    [platform, setPlatform] = useState('all'),
    [status, setStatus] = useState('all')
  const [copy, setCopy] = useState<CommercialGroup | null>(null),
    [copyResources, setCopyResources] = useState(true),
    [remove, setRemove] = useState<CommercialGroup | null>(null)
  function open(group: CommercialGroup | null) {
    setEdit(group)
    setForm({
      ...EMPTY,
      ...group,
      platform:
        group?.platform === 'claude'
          ? 'anthropic'
          : group?.platform || EMPTY.platform,
      models: group?.models || [],
      rate_multiplier: group?.rate_multiplier ?? 1,
      is_exclusive: group?.is_exclusive ?? false,
      daily_limit_usd: group?.daily_limit_usd ?? 0,
      weekly_limit_usd: group?.weekly_limit_usd ?? 0,
      monthly_limit_usd: group?.monthly_limit_usd ?? 0,
      rpm_limit: group?.rpm_limit ?? 0,
    })
  }
  return (
    <PageHeader
      title={staff ? t('groups:title') : t('groups:availableServices')}
      description={t('groups:description')}
      extra={
        admin ? (
          <Button onClick={() => open(null)}>{t('groups:create')}</Button>
        ) : null
      }
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      <div className='mb-4 flex flex-wrap gap-2'>
        <Input
          className='max-w-xs'
          placeholder={t('groups:searchGroups')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label={t('groups:filterPlatform')}
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className='rounded border bg-background p-2'
        >
          <option value='all'>{t('groups:allPlatforms')}</option>
          <option value='anthropic'>Claude</option>
          <option value='openai'>GPT</option>
          <option value='mixed'>{t('groups:mixed')}</option>
        </select>
        <select
          aria-label={t('groups:filterStatus')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className='rounded border bg-background p-2'
        >
          <option value='all'>{t('groups:allStatuses')}</option>
          <option value='active'>{t('groups:enabled')}</option>
          <option value='inactive'>{t('groups:disabled')}</option>
        </select>
      </div>
      <div className='overflow-auto rounded-md border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                t('groups:name'),
                t('groups:platform'),
                t('groups:billing'),
                t('groups:multiplier'),
                t('groups:status'),
                ...(staff ? [t('groups:capacity')] : []),
                ...(Boolean(me.data?.role) ? [t('groups:usage')] : []),
                ...(staff ? [t('groups:actions')] : []),
              ].map((v) => (
                <th key={v} className='p-3 text-left whitespace-nowrap'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data?.items
              .filter(
                (g) =>
                  g.name.toLowerCase().includes(search.toLowerCase()) &&
                  (platform === 'all' || g.platform === platform) &&
                  (status === 'all' || g.status === status)
              )
              .map((g) => (
                <tr key={g.id} className='border-b'>
                  <td className='p-3'>
                    <b>{g.name}</b>
                    <p className='text-xs text-muted-foreground'>
                      {g.description}
                    </p>
                  </td>
                  <td className='p-3'>
                    {g.platform === 'mixed'
                      ? t('groups:mixed')
                      : g.platform === 'anthropic'
                        ? 'Claude'
                        : g.platform === 'openai'
                          ? 'GPT'
                          : g.platform}
                  </td>
                  <td className='p-3'>
                    {g.subscription_type === 'subscription'
                      ? t('groups:subscription')
                      : t('groups:balance')}
                  </td>
                  <td className='p-3'>
                    {g.rate_multiplier == null ? '—' : g.rate_multiplier + '×'}
                  </td>
                  <td className='p-3'>
                    {g.status === 'active'
                      ? t('groups:enabled')
                      : t('groups:disabled')}
                  </td>
                  {staff && (
                    <td
                      className='p-3 whitespace-nowrap'
                      title={t('groups:sharedCapacity')}
                    >
                      {g.capacity?.kind === 'api'
                        ? t('groups:upstreamCapacity')
                        : `${g.capacity?.used ?? 0} / ${g.capacity?.limit ?? 0}`}
                      <p className='text-xs text-muted-foreground'>
                        {t('groups:resourceCount', {
                          count: g.resources?.length || 0,
                        })}
                      </p>
                    </td>
                  )}
                  {Boolean(me.data?.role) && (
                    <td className='p-3 text-xs leading-6 whitespace-nowrap'>
                      <p>
                        {t('groups:todayCost', {
                          amount: Number(g.usage?.today_cost || 0).toFixed(4),
                        })}
                      </p>
                      <p>
                        {t('groups:yesterdayCost', {
                          amount: Number(g.usage?.yesterday_cost || 0).toFixed(
                            4
                          ),
                        })}
                      </p>
                      <p>
                        {t('groups:totalCost', {
                          amount: Number(g.usage?.total_cost || 0).toFixed(4),
                        })}
                      </p>
                    </td>
                  )}
                  {staff ? (
                    <>
                      <td className='space-x-2 p-3'>
                        <Button
                          size='sm'
                          variant='outline'
                          onClick={() => {
                            setResourceGroup(g)
                            setResourceSearch('')
                            setPriorities(
                              Object.fromEntries(
                                (g.resources || []).map((r) => [
                                  r.resource_id,
                                  r.priority ?? 50,
                                ])
                              )
                            )
                            setKind(g.resources?.[0]?.resource_kind || 'vm')
                            setResources(
                              (g.resources || []).map((r) => r.resource_id)
                            )
                          }}
                        >
                          {t('groups:manageResources')}
                        </Button>
                        {admin ? (
                          <>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => open(g)}
                            >
                              {t('groups:edit')}
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              disabled={mutation.isPending}
                              onClick={() => {
                                setCopy(g)
                                setCopyResources(true)
                              }}
                            >
                              {t('groups:copy')}
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() =>
                                setOverrides({
                                  group: g,
                                  field: 'rate_multiplier',
                                })
                              }
                            >
                              {t('groups:userMultiplier')}
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() =>
                                setOverrides({ group: g, field: 'rpm_limit' })
                              }
                            >
                              {t('groups:userRpm')}
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() => setRemove(g)}
                            >
                              {t('groups:delete')}
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
          </tbody>
        </table>
        {!q.isLoading && !q.data?.items.length ? (
          <p className='p-6 text-center text-muted-foreground'>
            {t('groups:noGroups')}
          </p>
        ) : null}
      </div>
      <Dialog
        open={edit !== undefined}
        onOpenChange={(v) => !v && setEdit(undefined)}
      >
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              {edit ? t('groups:editGroup') : t('groups:create')}
            </DialogTitle>
          </DialogHeader>
          <form
            className='space-y-5'
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate({
                path: '/api/panel/groups' + (edit ? '/' + edit.id : ''),
                method: edit ? 'PATCH' : 'POST',
                body: {
                  ...form,
                  models: form.models,
                  expected_version: edit?.version,
                },
              })
            }}
          >
            <Label>
              {t('groups:name')}
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Label>
            <Label>
              {t('groups:notes')}
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </Label>
            <Label>
              {t('groups:platform')}
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
              >
                <option value='mixed'>{t('groups:mixedPlatform')}</option>
                <option value='anthropic'>Claude</option>
                <option value='openai'>GPT</option>
              </select>
            </Label>
            <ModelWhitelist
              value={form.models}
              onChange={(models) => setForm({ ...form, models })}
              platform={form.platform}
              enabled={edit !== undefined && admin}
            />
            <div className='grid gap-4 sm:grid-cols-2'>
              <Label>
                {t('groups:billingMultiplier')}
                <Input
                  type='number'
                  min='0'
                  step='0.01'
                  value={form.rate_multiplier}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      rate_multiplier: Number(e.target.value),
                    })
                  }
                />
              </Label>
              <Label>
                {t('groups:groupRpm')}
                <Input
                  type='number'
                  min='0'
                  value={form.rpm_limit}
                  onChange={(e) =>
                    setForm({ ...form, rpm_limit: Number(e.target.value) })
                  }
                />
              </Label>
            </div>
            <p className='text-xs text-muted-foreground'>
              {t('groups:rpmHelp')}
            </p>
            <label className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={form.is_exclusive}
                onChange={(e) =>
                  setForm({ ...form, is_exclusive: e.target.checked })
                }
              />
              {t('groups:exclusive')}
            </label>
            <Label>
              {t('groups:billingMethod')}
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.subscription_type}
                onChange={(e) =>
                  setForm({ ...form, subscription_type: e.target.value })
                }
              >
                <option value='standard'>{t('groups:balanceBilling')}</option>
                <option value='subscription'>{t('groups:subscription')}</option>
              </select>
            </Label>
            {form.subscription_type === 'subscription' ? (
              <div className='grid gap-4 sm:grid-cols-3'>
                {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                  <Label key={p}>
                    {t('groups:periodLimit', { period: t('groups:' + p) })}
                    <Input
                      type='number'
                      min='0'
                      step='0.01'
                      value={form[(p + '_limit_usd') as 'daily_limit_usd']}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          [p + '_limit_usd']: Number(e.target.value),
                        })
                      }
                    />
                  </Label>
                ))}
              </div>
            ) : null}
            <Label>
              {t('groups:status')}
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value='active'>{t('groups:enabled')}</option>
                <option value='inactive'>{t('groups:disabled')}</option>
              </select>
            </Label>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setEdit(undefined)}
              >
                {t('groups:cancel')}
              </Button>
              <Button disabled={mutation.isPending}>{t('groups:save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!resourceGroup}
        onOpenChange={(v) => !v && setResourceGroup(null)}
      >
        <DialogContent
          className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {t('groups:resourceTitle', { name: resourceGroup?.name })}
            </DialogTitle>
          </DialogHeader>
          <select
            aria-label={t('groups:backend')}
            className='h-9 rounded border bg-background px-2'
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setResources([])
            }}
          >
            <option value='vm'>{t('groups:vmSlots')}</option>
            {staff ? (
              <option value='api_endpoint'>{t('groups:apiEndpoints')}</option>
            ) : null}
          </select>
          {kind === 'api_endpoint' ? (
            <ApiResourcePicker value={resources} onChange={setResources} />
          ) : (
            <>
              <Input
                aria-label={t('groups:searchResources')}
                placeholder={t('groups:resourcePlaceholder')}
                value={resourceSearch}
                onChange={(e) => setResourceSearch(e.target.value)}
              />
              <div className='max-h-72 space-y-2 overflow-auto'>
                {options
                  .filter((r) =>
                    `${r.name} ${r.id}`
                      .toLowerCase()
                      .includes(resourceSearch.toLowerCase())
                  )
                  .map((r) => (
                    <label
                      key={r.id}
                      className='flex items-center gap-2 rounded border p-2'
                    >
                      <input
                        type='checkbox'
                        checked={resources.includes(r.id)}
                        onChange={(e) =>
                          setResources(
                            e.target.checked
                              ? [...resources, r.id]
                              : resources.filter((id) => id !== r.id)
                          )
                        }
                      />
                      {r.name}{' '}
                      <span className='text-xs text-muted-foreground'>
                        {r.state}
                      </span>
                      <Input
                        aria-label={t('groups:priorityLabel', { name: r.name })}
                        className='ml-auto w-20'
                        type='number'
                        min='0'
                        max='10000'
                        value={priorities[r.id] ?? 50}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setPriorities({
                            ...priorities,
                            [r.id]: Number(e.target.value),
                          })
                        }
                      />
                      <span className='text-xs text-muted-foreground'>
                        {r.id}
                      </span>
                    </label>
                  ))}
              </div>
            </>
          )}
          {kind === 'vm' && (
            <>
              <p className='text-xs leading-5 text-muted-foreground'>
                {t('groups:priorityHelp')}
              </p>
              {!options.length && (
                <p className='rounded border border-dashed p-4 text-sm text-muted-foreground'>
                  {t('groups:noVms')}
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setResourceGroup(null)}>
              {t('groups:cancel')}
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                (kind === 'api_endpoint'
                  ? endpoints.isLoading || !!endpoints.error
                  : vms.isLoading || !!vms.error)
              }
              onClick={() =>
                resourceGroup &&
                mutation.mutate({
                  path: '/api/panel/groups/' + resourceGroup.id + '/resources',
                  method: 'PUT',
                  body: {
                    expected_version: resourceGroup.version,
                    resources: resources.map((resource_id) => ({
                      resource_kind: kind,
                      resource_id,
                      ...(kind === 'vm'
                        ? { priority: priorities[resource_id] ?? 50 }
                        : {}),
                    })),
                  },
                })
              }
            >
              {t('groups:saveResources')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title={t('groups:deleteGroup')}
        desc={t('groups:deleteHelp')}
        confirmText={t('groups:delete')}
        destructive
        handleConfirm={() => {
          if (remove)
            mutation.mutate({
              path: '/api/panel/groups/' + remove.id,
              method: 'DELETE',
            })
          setRemove(null)
        }}
      />
      <Dialog open={!!copy} onOpenChange={(v) => !v && setCopy(null)}>
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              {t('groups:copy')}
              {copy?.name}
            </DialogTitle>
          </DialogHeader>
          <label className='flex gap-2'>
            <input
              type='checkbox'
              checked={copyResources}
              onChange={(e) => setCopyResources(e.target.checked)}
            />
            {t('groups:copyResources')}
          </label>
          <p className='text-sm text-muted-foreground'>
            {t('groups:copyHelp')}
          </p>
          <DialogFooter>
            <Button
              disabled={mutation.isPending}
              onClick={() => {
                if (copy)
                  mutation.mutate({
                    path: '/api/panel/groups/' + copy.id + '/duplicate',
                    method: 'POST',
                    body: {
                      name: t('groups:copyName', {
                        name: copy.name,
                        suffix: Date.now().toString().slice(-5),
                      }),
                      copy_resources: copyResources,
                    },
                  })
                setCopy(null)
              }}
            >
              {t('groups:copy')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {overrides && (
        <GroupUserOverrides {...overrides} onClose={() => setOverrides(null)} />
      )}
    </PageHeader>
  )
}

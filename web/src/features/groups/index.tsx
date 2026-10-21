import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  const [overrides, setOverrides] = useState<{
    group: CommercialGroup
    field: 'rate_multiplier' | 'rpm_limit'
  } | null>(null)
  const q = useQuery(groupsQueryOptions())
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'admin'
  const staff = admin || me.data?.role === 'super'
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
      toast.success('已保存')
      await qc.invalidateQueries({ queryKey: ['panel'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const options = (vms.data?.items || []).map((v) => ({
    id: v.id,
    name: v.name || v.id,
    state: v.availability?.text || (v.has_token ? '待检测' : '无凭证'),
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
      title={staff ? '分组' : '可用服务'}
      description='分组连接可用模型、资源与用户权益。'
      extra={
        admin ? <Button onClick={() => open(null)}>新建分组</Button> : null
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
          placeholder='搜索分组名称'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label='筛选平台'
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className='rounded border bg-background p-2'
        >
          <option value='all'>全部平台</option>
          <option value='anthropic'>Claude</option>
          <option value='openai'>GPT</option>
          <option value='mixed'>混合</option>
        </select>
        <select
          aria-label='筛选状态'
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className='rounded border bg-background p-2'
        >
          <option value='all'>全部状态</option>
          <option value='active'>启用</option>
          <option value='inactive'>停用</option>
        </select>
      </div>
      <div className='overflow-auto rounded-md border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                '名称',
                '平台',
                '计费',
                '倍率',
                '状态',
                ...(staff ? ['容量'] : []),
                ...(me.data?.role !== 'super' ? ['用量'] : []),
                ...(staff ? ['操作'] : []),
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
                  <td className='p-3'>{g.platform}</td>
                  <td className='p-3'>
                    {g.subscription_type === 'subscription' ? '套餐' : '余额'}
                  </td>
                  <td className='p-3'>
                    {g.rate_multiplier == null ? '—' : g.rate_multiplier + '×'}
                  </td>
                  <td className='p-3'>
                    {g.status === 'active' ? '启用' : '停用'}
                  </td>
                  {staff && (
                    <td
                      className='p-3 whitespace-nowrap'
                      title='同一 VM 在多个分组间共享并发容量'
                    >
                      {g.capacity?.kind === 'api'
                        ? '由上游 API 决定'
                        : `${g.capacity?.used ?? 0} / ${g.capacity?.limit ?? 0}`}
                      <p className='text-xs text-muted-foreground'>
                        {g.resources?.length || 0} 个资源
                      </p>
                    </td>
                  )}
                  {me.data?.role !== 'super' && (
                    <td className='p-3 text-xs leading-6 whitespace-nowrap'>
                      <p>今日 ${Number(g.usage?.today_cost || 0).toFixed(4)}</p>
                      <p>
                        昨日 ${Number(g.usage?.yesterday_cost || 0).toFixed(4)}
                      </p>
                      <p>累计 ${Number(g.usage?.total_cost || 0).toFixed(4)}</p>
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
                          管理资源
                        </Button>
                        {admin ? (
                          <>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => open(g)}
                            >
                              编辑
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
                              复制
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
                              专属倍率
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() =>
                                setOverrides({ group: g, field: 'rpm_limit' })
                              }
                            >
                              专属 RPM
                            </Button>
                            <Button
                              size='sm'
                              variant='ghost'
                              onClick={() => setRemove(g)}
                            >
                              删除
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
          <p className='p-6 text-center text-muted-foreground'>暂无可用分组</p>
        ) : null}
      </div>
      <Dialog
        open={edit !== undefined}
        onOpenChange={(v) => !v && setEdit(undefined)}
      >
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{edit ? '编辑分组' : '新建分组'}</DialogTitle>
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
              名称
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Label>
            <Label>
              说明
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </Label>
            <Label>
              平台
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
              >
                <option value='mixed'>Claude / GPT 混合</option>
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
                计费倍率
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
                分组 RPM（0 = 不限制）
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
              每个用户在本分组内的每分钟请求上限，同用户的多个 API Key 共享；0 =
              不限制分组 RPM，仍受用户全局 RPM 上限约束。
            </p>
            <label className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={form.is_exclusive}
                onChange={(e) =>
                  setForm({ ...form, is_exclusive: e.target.checked })
                }
              />
              专属分组（需明确授权）
            </label>
            <Label>
              计费方式
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.subscription_type}
                onChange={(e) =>
                  setForm({ ...form, subscription_type: e.target.value })
                }
              >
                <option value='standard'>余额计费</option>
                <option value='subscription'>套餐</option>
              </select>
            </Label>
            {form.subscription_type === 'subscription' ? (
              <div className='grid gap-4 sm:grid-cols-3'>
                {(['daily', 'weekly', 'monthly'] as const).map((p) => (
                  <Label key={p}>
                    {p === 'daily'
                      ? '24 小时'
                      : p === 'weekly'
                        ? '7 天'
                        : '30 天'}
                    限额 USD
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
              状态
              <select
                className='h-9 w-full rounded border bg-background px-2'
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                <option value='active'>启用</option>
                <option value='inactive'>停用</option>
              </select>
            </Label>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => setEdit(undefined)}
              >
                取消
              </Button>
              <Button disabled={mutation.isPending}>保存</Button>
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
            <DialogTitle>{resourceGroup?.name} · 分组资源</DialogTitle>
          </DialogHeader>
          <select
            aria-label='执行后端'
            className='h-9 rounded border bg-background px-2'
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setResources([])
            }}
          >
            <option value='vm'>VM 槽位</option>
            {staff ? <option value='api_endpoint'>API 地址</option> : null}
          </select>
          {kind === 'api_endpoint' ? (
            <ApiResourcePicker value={resources} onChange={setResources} />
          ) : (
            <>
              <Input
                aria-label='搜索分组资源'
                placeholder='搜索资源名称或 ID…'
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
                        aria-label={r.name + ' 组内优先级'}
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
                同一 VM 可加入多个分组并共享容量。组内优先级数值越小越优先；VM
                先按原调度等级分层。
              </p>
              {!options.length && (
                <p className='rounded border border-dashed p-4 text-sm text-muted-foreground'>
                  暂无 VM，请先创建槽位。
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={() => setResourceGroup(null)}>
              取消
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
              保存资源
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title='删除分组'
        desc='仍被 Key、套餐引用的分组会拒绝删除；历史消费与账务保留。'
        confirmText='删除'
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
            <DialogTitle>复制 {copy?.name}</DialogTitle>
          </DialogHeader>
          <label className='flex gap-2'>
            <input
              type='checkbox'
              checked={copyResources}
              onChange={(e) => setCopyResources(e.target.checked)}
            />
            同时复制资源关联
          </label>
          <p className='text-sm text-muted-foreground'>
            不会复制用户授权、套餐和资金。
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
                      name:
                        copy.name + ' 副本 ' + Date.now().toString().slice(-5),
                      copy_resources: copyResources,
                    },
                  })
                setCopy(null)
              }}
            >
              复制
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

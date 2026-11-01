import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import type {
  ClusterApiNode,
  DockerContainer,
  DockerContainerInput,
  DockerInstallJob,
  DockerLogs,
} from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { StatusMark } from '@/components/status-mark'
import {
  CLUSTER_NODES_KEY,
  dockerContainersQueryOptions,
  dockerInfoQueryOptions,
  jsonBody,
} from '@/features/cluster/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'

function getStateTones(): Record<
  string,
  { key: string; cls: string; text: string }
> {
  return {
    running: { key: 'ok', cls: 'ok', text: translate('cluster:state.running') },
    restarting: {
      key: 'caution',
      cls: 'caution',
      text: translate('cluster:state.restarting'),
    },
    paused: {
      key: 'caution',
      cls: 'caution',
      text: translate('cluster:state.paused'),
    },
    created: {
      key: 'none',
      cls: 'none',
      text: translate('cluster:state.created'),
    },
    exited: {
      key: 'off',
      cls: 'off',
      text: translate('cluster:state.stopped'),
    },
    dead: { key: 'bad', cls: 'bad', text: translate('cluster:state.error') },
  }
}

/** 与节点槽位容器名一致：`vm-14` → `kin-14`。 */
function slotContainerName(vmId: string) {
  return `kin-${vmId.replace(/^vm-/, '')}`
}

/** 槽位已登记但节点上还没有容器时，Docker 表仍要能看到它。 */
function absentSlotRow(vm: Vm): DockerContainer & { absent: true } {
  return {
    id: `slot:${vm.id}`,
    name: slotContainerName(vm.id),
    image: vm.kernel || '—',
    state: 'created',
    status:
      vm.status === 'running'
        ? translate('cluster:docker.missingRunning')
        : translate('cluster:docker.notCreated'),
    created_at: typeof vm.created_at === 'string' ? vm.created_at : null,
    ports: [],
    managed: true,
    vm_id: vm.id,
    role: 'slot',
    absent: true,
  }
}
export function DockerTab({ node }: { node: ClusterApiNode }) {
  const { t } = useTranslation('cluster')

  const qc = useQueryClient()
  const ready = node.link.state === 'ready'
  const dockerOk = ready && node.health?.docker.ok === true
  const info = useQuery(dockerInfoQueryOptions(node.id, dockerOk))
  const containers = useQuery(dockerContainersQueryOptions(node.id, dockerOk))
  const slots = useQuery(vmsListQueryOptions())
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const base = `/api/panel/cluster/nodes/${node.id}/docker`
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['panel', 'cluster', node.id, 'docker'] })

  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: string }) =>
      act === 'remove'
        ? api(`${base}/containers/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          })
        : api(`${base}/containers/${encodeURIComponent(id)}/${act}`, {
            method: 'POST',
          }),
    onSuccess: refresh,
    onError: (err) => toast.error(err.message),
  })

  const install = useMutation({
    mutationFn: () =>
      api<DockerInstallJob>(`${base}/install`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY }),
    onError: (err) => toast.error(err.message),
  })

  if (node.platform === 'darwin') {
    return (
      <p className='text-sm text-muted-foreground'>{t('docker.macNative')}</p>
    )
  }

  if (!ready) {
    return (
      <p className='text-sm text-muted-foreground'>
        {t('docker.disconnected')}
      </p>
    )
  }

  if (!dockerOk) {
    const job = node.install
    return (
      <div className='space-y-3 text-sm'>
        <p className='text-muted-foreground'>
          {t('docker.unavailable', {
            value1: node.health?.docker.error || t('docker.checking'),
          })}
        </p>
        <Button
          onClick={() => install.mutate()}
          disabled={install.isPending || job?.status === 'running'}
        >
          {job?.status === 'running'
            ? t('docker.installing')
            : t('docker.install')}
        </Button>
        <p className='text-xs text-muted-foreground'>
          {t('docker.installDescription', { value1: node.username })}
        </p>
        {job ? (
          <pre className='max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] whitespace-pre-wrap'>
            {job.status === 'running'
              ? job.log || '…'
              : t('docker.hostInfo', {
                  value1:
                    job.status === 'done'
                      ? t('docker.installDone')
                      : t('docker.installFailed', {
                          code: job.exit_code ?? '—',
                        }),
                  value2: job.log,
                })}
          </pre>
        ) : null}
      </div>
    )
  }

  // 同一 VM 的槽位与出口挨着：kin-02 → kin-02-egress；其余容器按名字排在后面。
  // 节点上还没容器的槽位也要出现，否则管理页看起来像这台 VPS 没有这个 VM。
  const live = containers.data || []
  const seen = new Set(
    live.flatMap((c) => [c.vm_id, c.name].filter((v): v is string => !!v))
  )
  const missing = (slots.data?.items || [])
    .filter((vm) => vm.node_id === node.id)
    .filter((vm) => !seen.has(vm.id) && !seen.has(slotContainerName(vm.id)))
    .map(absentSlotRow)
  const items = [...missing, ...live].sort((a, b) => {
    const ka = a.vm_id
      ? `0${a.vm_id}${a.role === 'egress' ? '1' : '0'}`
      : `1${a.name}`
    const kb = b.vm_id
      ? `0${b.vm_id}${b.role === 'egress' ? '1' : '0'}`
      : `1${b.name}`
    return ka.localeCompare(kb)
  })

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
        <span>Docker {info.data?.version || '—'}</span>
        <span>{info.data?.os || '—'}</span>
        <span>
          {info.data?.cpus ?? '—'} CPU ·{' '}
          {info.data?.mem_bytes
            ? `${(info.data.mem_bytes / 1024 ** 3).toFixed(1)} GiB`
            : '—'}
        </span>
        <span>
          {t('docker.runningCount', {
            value1: info.data?.running ?? '—',
            value2: info.data?.containers ?? '—',
          })}
        </span>
      </div>

      <CreateContainerForm base={base} onCreated={refresh} />

      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full min-w-[640px] text-sm'>
          <thead className='bg-muted/30 text-[11px] text-muted-foreground'>
            <tr>
              <th className='px-3 py-1.5 text-left font-medium'>
                {t('containers')}
              </th>
              <th className='px-3 py-1.5 text-left font-medium'>
                {t('image')}
              </th>
              <th className='px-3 py-1.5 text-left font-medium'>
                {t('status')}
              </th>
              <th className='px-3 py-1.5 text-left font-medium'>{t('port')}</th>
              <th className='px-3 py-1.5 text-right font-medium'>
                {t('actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className='px-3 py-6 text-center text-xs text-muted-foreground'
                >
                  {containers.isLoading
                    ? t('loading')
                    : containers.error
                      ? containers.error.message
                      : t('docker.empty')}
                </td>
              </tr>
            ) : (
              items.map((c) => {
                const absent = 'absent' in c && c.absent
                // A crash-looping container reports `restarting`; it still needs 停止, not 启动.
                const running =
                  c.state === 'running' || c.state === 'restarting'
                const busy = action.isPending && action.variables?.id === c.id
                return (
                  <tr key={c.id} className='border-t border-border/40'>
                    <td className='px-3 py-1.5'>
                      <div className='flex items-center gap-1.5 font-medium'>
                        <span className={c.role === 'egress' ? 'pl-3' : ''}>
                          {c.name}
                        </span>
                        {c.vm_id ? (
                          <span className='rounded-[4px] border border-border/70 px-1 text-[10px] leading-4 font-normal text-muted-foreground'>
                            {c.role === 'egress'
                              ? t('docker.egress', { value1: c.vm_id })
                              : c.vm_id}
                          </span>
                        ) : null}
                      </div>
                      <div className='font-mono text-[10px] text-muted-foreground'>
                        {absent ? '—' : c.id.slice(0, 12)}
                      </div>
                    </td>
                    <td className='px-3 py-1.5 text-xs'>{c.image}</td>
                    <td className='px-3 py-1.5'>
                      <div className='flex items-center gap-1.5'>
                        <StatusMark
                          tone={
                            getStateTones()[c.state] || {
                              key: 'none',
                              cls: 'none',
                              text: c.state,
                            }
                          }
                        />
                        <span className='text-[11px] text-muted-foreground'>
                          {c.status}
                        </span>
                      </div>
                    </td>
                    <td className='px-3 py-1.5 font-mono text-[11px]'>
                      {c.ports.join(' ') || '—'}
                    </td>
                    <td className='px-3 py-1.5 text-right whitespace-nowrap'>
                      {absent ? (
                        <span className='text-[11px] text-muted-foreground'>
                          {t('docker.noContainer')}
                        </span>
                      ) : (
                        <>
                          {(running
                            ? (['stop', 'restart'] as const)
                            : (['start'] as const)
                          ).map((act) => (
                            <Button
                              key={act}
                              size='sm'
                              variant='ghost'
                              className='h-7 px-2 text-xs'
                              disabled={busy}
                              onClick={() => action.mutate({ id: c.id, act })}
                            >
                              {act === 'stop'
                                ? t('stop')
                                : act === 'restart'
                                  ? t('restart')
                                  : t('start')}
                            </Button>
                          ))}
                          <Button
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-xs'
                            onClick={() =>
                              setLogsFor(logsFor === c.id ? null : c.id)
                            }
                          >
                            {t('logs')}
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            className='h-7 px-2 text-xs text-red-3'
                            disabled={busy}
                            onClick={() => setRemoveTarget(c.id)}
                          >
                            {t('delete')}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {logsFor ? <ContainerLogs base={base} id={logsFor} /> : null}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title={t('docker.deleteTitle')}
        desc={t('docker.deleteDescription')}
        confirmText={t('delete')}
        cancelBtnText={t('cancel')}
        destructive
        handleConfirm={() => {
          if (!removeTarget) return
          action.mutate({ id: removeTarget, act: 'remove' })
          if (logsFor === removeTarget) setLogsFor(null)
          setRemoveTarget(null)
        }}
      />
    </div>
  )
}

function CreateContainerForm({
  base,
  onCreated,
}: {
  base: string
  onCreated: () => void
}) {
  const { t } = useTranslation('cluster')

  const [image, setImage] = useState('')
  const [name, setName] = useState('')
  const [ports, setPorts] = useState('')
  const [env, setEnv] = useState('')
  const [restart, setRestart] =
    useState<NonNullable<DockerContainerInput['restart']>>('unless-stopped')

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(
        `${base}/containers`,
        jsonBody({
          image: image.trim(),
          name: name.trim() || undefined,
          ports: ports
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          env: env
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          restart,
        } satisfies DockerContainerInput)
      ),
    onSuccess: () => {
      toast.success(t('docker.created'))
      setImage('')
      setName('')
      setPorts('')
      setEnv('')
      onCreated()
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className='grid grid-cols-12 gap-2 rounded-md border p-3'>
      <div className='col-span-12 space-y-1 sm:col-span-4'>
        <Label className='text-xs'>{t('image')}</Label>
        <Input
          placeholder='nginx:alpine'
          spellCheck={false}
          value={image}
          onChange={(e) => setImage(e.target.value)}
        />
      </div>
      <div className='col-span-6 space-y-1 sm:col-span-3'>
        <Label className='text-xs'>{t('name')}</Label>
        <Input
          placeholder={t('optional')}
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className='col-span-6 space-y-1 sm:col-span-3'>
        <Label className='text-xs'>{t('port')}</Label>
        <Input
          placeholder='8080:80, 8443:443'
          spellCheck={false}
          value={ports}
          onChange={(e) => setPorts(e.target.value)}
        />
      </div>
      <div className='col-span-12 space-y-1 sm:col-span-2'>
        <Label className='text-xs'>{t('restart')}</Label>
        <Select
          value={restart}
          onValueChange={(v) => setRestart(v as typeof restart)}
        >
          <SelectTrigger className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='unless-stopped'>
              {/* i18n-exempt "unless-stopped" -- Docker restart policy wire value; must match Docker API spelling. */}
              unless-stopped
            </SelectItem>
            <SelectItem value='always'>
              {/* i18n-exempt "always" -- Docker restart policy wire value; must match Docker API spelling. */}
              always
            </SelectItem>
            <SelectItem value='on-failure'>
              {/* i18n-exempt "on-failure" -- Docker restart policy wire value; must match Docker API spelling. */}
              on-failure
            </SelectItem>
            <SelectItem value='no'>
              {/* i18n-exempt "no" -- Docker restart policy wire value; must match Docker API spelling. */}
              no
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className='col-span-12 space-y-1 sm:col-span-10'>
        <Label className='text-xs'>{t('docker.environment')}</Label>
        <Textarea
          placeholder={t('docker.environmentHint')}
          spellCheck={false}
          className='h-16 font-mono text-[11px]'
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
      </div>
      <div className='col-span-12 flex items-end sm:col-span-2'>
        <Button
          className='w-full'
          disabled={!image.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? t('docker.creating') : t('docker.createStart')}
        </Button>
      </div>
    </div>
  )
}

function ContainerLogs({ base, id }: { base: string; id: string }) {
  const { t } = useTranslation('cluster')

  const logs = useQuery({
    queryKey: ['panel', 'cluster', base, 'logs', id] as const,
    queryFn: () =>
      api<DockerLogs>(
        `${base}/containers/${encodeURIComponent(id)}/logs?tail=300`
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: false,
  })
  return (
    <div className='space-y-1'>
      <div className='text-xs text-muted-foreground'>
        {t('docker.logsTitle', { value1: id.slice(0, 12) })}
      </div>
      <pre className='max-h-72 overflow-auto rounded-md border bg-[#0b0d10] p-2 font-mono text-[11px] text-neutral-200'>
        {logs.isLoading
          ? t('loading')
          : logs.error
            ? logs.error.message
            : (logs.data?.lines || []).map((line, i) => (
                <span
                  key={i}
                  className={cn(line.stream === 'stderr' && 'text-amber-300')}
                >
                  {line.text}
                </span>
              ))}
      </pre>
    </div>
  )
}

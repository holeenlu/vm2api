import type { ComponentProps, ReactElement, ReactNode } from 'react'
import type { Vm, VmKernelSnapshot, VmSeedSettings } from '@/types/panel-vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { TelemetryPane } from '@/features/settings/telemetry-pane'
import { VmDetailPage } from './detail-page'
import { SeedPolicyCard } from './seed-policy-card'
import { seedSaveState } from './seed-settings'

// Drive the actual component callbacks and rerenders without a DOM dependency.
// Child UI primitives stay as React elements; no serializer/helper is substituted.
const host = vi.hoisted(() => ({
  values: [] as unknown[],
  deps: [] as unknown[][],
  cursor: 0,
  effects: [] as (() => void)[],
  dirty: false,
  vms: [] as Vm[],
  observations: {} as Record<string, VmKernelSnapshot['telemetry']>,
  seed: {} as VmSeedSettings,
  readError: null as Error | null,
  uploadError: null as Error | null,
  logs: [] as string[],
  queries: [] as { queryKey: readonly unknown[] }[],
  api: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = host.cursor++
    if (!(index in host.values))
      host.values[index] = typeof initial === 'function' ? initial() : initial
    return [
      host.values[index],
      (value: unknown) => {
        const next =
          typeof value === 'function' ? value(host.values[index]) : value
        host.dirty ||= !Object.is(next, host.values[index])
        host.values[index] = next
      },
    ]
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = host.cursor++
    if (
      !host.deps[index] ||
      deps.some((value, i) => !Object.is(value, host.deps[index][i]))
    ) {
      host.deps[index] = deps
      host.effects.push(effect)
    }
  },
  useMemo: (create: () => unknown) => create(),
}))
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, values?: object) =>
      `${key}${values ? ' ' + JSON.stringify(values) : ''}`,
  }),
}))
vi.mock('sonner', () => ({ toast: host.toast }))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: host.api,
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: host.invalidate }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const data = queryKey.includes('dashboard')
      ? { vms: host.vms }
      : queryKey.includes('seed-upload-log')
        ? host.logs
        : queryKey.includes('seed')
          ? host.seed
          : queryKey[1] === 'vm'
            ? {
                vm: host.vms.find((vm) => vm.id === queryKey[2]),
                kernel: { telemetry: host.observations[String(queryKey[2])] },
              }
            : {}
    const error = queryKey.includes('seed-upload-log')
      ? host.uploadError
      : queryKey.includes('seed')
        ? host.readError
        : null
    return {
      data,
      error,
      isError: !!error,
      isLoading: false,
      isPending: false,
      isFetching: false,
    }
  },
  useQueries: ({
    queries,
  }: {
    queries: { queryKey: readonly unknown[] }[]
  }) => {
    host.queries = queries
    return queries.map(({ queryKey }) => ({
      data: { kernel: { telemetry: host.observations[String(queryKey[2])] } },
      isPending: false,
    }))
  },
  useMutationState: () => [],
  useMutation: (options: {
    mutationFn: (value: unknown) => Promise<unknown>
    onSuccess?: (value: unknown) => Promise<void>
    onError?: (error: Error) => Promise<void>
  }) => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: async (value: unknown) => {
      try {
        const result = await options.mutationFn(value)
        await options.onSuccess?.(result)
        return result
      } catch (error) {
        await options.onError?.(error as Error)
        throw error
      }
    },
  }),
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'vm-1' }),
}))
vi.mock('./use-pool-seat-stream', () => ({
  usePoolSeatStream: () => undefined,
}))
vi.mock('./use-vm-test-chat', () => ({ useVmTestChat: () => ({}) }))
vi.mock('@/hooks/use-now', () => ({ useNow: () => 1_000 }))
vi.mock('./vm-perms', async (original) => ({
  ...(await original<typeof import('./vm-perms')>()),
  useVmPerms: () => ({
    known: true,
    admin: true,
    dashboard: true,
    power: true,
  }),
}))

type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children as ReactNode)]
}
function find(node: ReactNode, predicate: (item: Element) => boolean): Element {
  const found = elements(node).find(predicate)
  expect(found).toBeDefined()
  return found!
}
function named(node: ReactNode, name: string): Element {
  return find(
    node,
    (item) => typeof item.type === 'function' && item.type.name === name
  )
}
function render<T>(component: () => T): T {
  let tree: T
  for (let tries = 0; tries < 5; tries++) {
    host.cursor = 0
    host.dirty = false
    tree = component()
    host.effects.splice(0).forEach((effect) => effect())
    if (!host.dirty) return tree
  }
  throw new Error('Component state did not settle')
}
function invoke(item: Element, prop: string, ...args: unknown[]) {
  return (item.props[prop] as (...args: unknown[]) => unknown)(...args)
}
function expand(item: Element): ReactNode {
  return (item.type as (props: Record<string, unknown>) => ReactNode)(
    item.props
  )
}
const seed: VmSeedSettings = {
  seed_policy: { telemetry_disabled: false },
  settings_json: { theme: 'dark', env: { CUSTOM: 'original' } },
  claude_setting: 'ORIGINAL=1',
}
const disabled = {
  enabled: false,
  state: 'disabled',
  pending_events: 0,
} as VmKernelSnapshot['telemetry']
function resetHooks() {
  host.values = []
  host.deps = []
  host.effects = []
  host.cursor = 0
}
beforeEach(() => {
  vi.clearAllMocks()
  resetHooks()
  host.vms = [
    {
      id: 'vm-1',
      status: 'running',
      seed_policy: { telemetry_disabled: true },
    } as Vm,
  ]
  host.observations = {}
  host.seed = structuredClone(seed)
  host.readError = null
  host.uploadError = null
  host.logs = []
  host.api.mockReset().mockResolvedValue({ saved: true, applied: true })
})
function card(extra: Partial<ComponentProps<typeof SeedPolicyCard>> = {}) {
  let props: ComponentProps<typeof SeedPolicyCard> = {
    seed: structuredClone(seed),
    slot: {},
    saving: false,
    debug: false,
    onDebug: vi.fn(),
    onSave: vi.fn().mockResolvedValue({}),
    ...extra,
  }
  const current = () => render(() => SeedPolicyCard(props))
  const update = (next: Partial<typeof props>) => {
    props = { ...props, ...next }
    return current()
  }
  const dialog = (title: string) =>
    find(current(), (item) => item.props.title === title)
  const unlock = () =>
    invoke(dialog('vm:seedPolicyCard.unlockSeedConfiguration'), 'handleConfirm')
  return { current, update, dialog, unlock, props }
}

describe('seed form component save flow', () => {
  it('keeps an unlocked draft across polling and sends only its explicit edits', async () => {
    const form = card()
    form.unlock()
    invoke(
      find(form.current(), (item) => item.props['aria-label'] === 'theme'),
      'onChange',
      { target: { value: 'light' } }
    )
    form.update({
      seed: {
        ...seed,
        seed_policy: { telemetry_disabled: true },
        settings_json: { theme: 'server-theme', env: { CUSTOM: 'server-env' } },
      },
      slot: { locale: 'ja_JP.UTF-8' },
    })
    expect(
      find(form.current(), (item) => item.props['aria-label'] === 'theme').props
        .value
    ).toBe('light')
    await invoke(
      form.dialog('vm:seedPolicyCard.confirmSeeding'),
      'handleConfirm'
    )
    expect(form.props.onSave).toHaveBeenCalledWith({ theme: 'light' })
    expect(
      find(form.current(), (item) => item.props['aria-label'] === 'theme').props
        .disabled
    ).toBe(true)
  })

  it('awaits save completion and preserves an unlocked draft after rejection', async () => {
    let reject!: (error: Error) => void
    const onSave = vi.fn(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const form = card({ onSave })
    form.unlock()
    invoke(
      find(form.current(), (item) => item.props['aria-label'] === 'theme'),
      'onChange',
      { target: { value: 'light' } }
    )
    invoke(
      find(
        form.current(),
        (item) => item.props.children === 'vm:officialCcCard.applySeed'
      ),
      'onClick'
    )
    const pending = invoke(
      form.dialog('vm:seedPolicyCard.confirmSeeding'),
      'handleConfirm'
    )
    expect(
      find(form.current(), (item) => item.props['aria-label'] === 'theme').props
        .disabled
    ).toBe(false)
    reject(new Error('publish failed'))
    await pending
    const input = find(
      form.current(),
      (item) => item.props['aria-label'] === 'theme'
    )
    expect(input.props).toMatchObject({ value: 'light', disabled: false })
    expect(form.dialog('vm:seedPolicyCard.confirmSeeding').props.open).toBe(
      true
    )
  })

  it.each(['query', 'files'])(
    'blocks editing and submission on a %s read failure, retaining the draft',
    async (kind) => {
      const form = card()
      form.unlock()
      invoke(
        find(form.current(), (item) => item.props.id === 'seed-claude-setting'),
        'onChange',
        { target: { value: 'DRAFT=1' } }
      )
      form.update(
        kind === 'query'
          ? { readError: 'read failed' }
          : {
              seed: {
                ...seed,
                seed_files: {
                  ok: false,
                  source: 'node',
                  files: {
                    settings_json: 'error',
                    claude_setting: 'error',
                    kin_seed: 'error',
                  },
                  error: 'read failed',
                },
              },
            }
      )
      expect(
        find(form.current(), (item) => item.props.id === 'seed-claude-setting')
          .props
      ).toMatchObject({ disabled: true, value: 'DRAFT=1' })
      await invoke(
        form.dialog('vm:seedPolicyCard.confirmSeeding'),
        'handleConfirm'
      )
      expect(form.props.onSave).not.toHaveBeenCalled()
    }
  )

  it('renders native upload counts and displays a read failure without hiding it as an empty log', () => {
    const form = card({
      debug: true,
      uploadLog: [
        JSON.stringify({
          at: '2026-10-31T12:00:00Z',
          ok: false,
          events: 3,
          error: 'upload_failed',
        }),
      ],
    })
    const upload = () => expand(named(form.current(), 'TelemetryUploadLog'))
    expect(JSON.stringify(upload())).toContain('uploadCounts')
    expect(
      find(upload(), (item) => item.type === 'pre').props.children
    ).toContain('upload_failed')
    form.update({ uploadError: 'node unavailable' })
    expect(
      find(upload(), (item) => item.props.role === 'alert').props.children
    ).toContain('node unavailable')
    form.update({ uploadError: null, uploadLoading: true })
    expect(JSON.stringify(upload())).toContain('uploadLoading')
  })

  it('allows an unchanged unconfirmed policy to be republished, then disables it after confirmation', () => {
    const form = card({
      seed: { ...seed, seed_policy: { telemetry_disabled: true } },
    })
    form.unlock()
    const button = () =>
      find(
        form.current(),
        (item) => item.props.children === 'vm:officialCcCard.applySeed'
      )
    expect(button().props.disabled).toBe(false)
    form.update({ telemetry: disabled })
    expect(button().props.disabled).toBe(true)
  })
})

function pane() {
  return render(() =>
    TelemetryPane({ interval: 300, onIntervalChange: vi.fn() })
  )
}
function slotTree() {
  return expand(named(pane(), 'SlotRow'))
}
function slotOff() {
  return find(slotTree(), (item) =>
    String(item.props['aria-label']).startsWith('telemetry.disableSlot')
  )
}

describe('native telemetry settings component', () => {
  it('probes stored opt-outs and keeps the same-value retry enabled until native confirmation', () => {
    expect(slotOff().props.disabled).toBe(false)
    expect(host.queries.map((query) => query.queryKey)).toEqual([
      ['panel', 'vm', 'vm-1'],
    ])
    expect(slotOff().props.title).toBe('telemetry.republish')
    host.observations['vm-1'] = disabled
    expect(slotOff().props.disabled).toBe(true)
  })

  it.each([
    [{ saved: true }, 'warning', 'telemetry.slotSaved'],
    [{ saved: true, published: true }, 'info', 'telemetry.slotPublished'],
    [{ saved: true, applied: true }, 'success', 'telemetry.slotDisabled'],
    [
      { saved: true, service: { supported: false } },
      'warning',
      'telemetry.slotUnsupported',
    ],
  ] as const)(
    'reports the actual native save result %j',
    async (result, tone, key) => {
      host.api.mockResolvedValue(result)
      await invoke(slotOff(), 'onClick')
      expect(host.api).toHaveBeenCalledWith(
        '/api/panel/vms/vm-1/seed-settings',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"telemetry_disabled":true'),
        })
      )
      await vi.waitFor(() =>
        expect(host.toast[tone]).toHaveBeenCalledWith(
          expect.stringContaining(key)
        )
      )
      if (tone !== 'success') expect(host.toast.success).not.toHaveBeenCalled()
    }
  )

  it('retains saved-but-unconfirmed failures and lets the user retry OFF', async () => {
    host.api.mockRejectedValue(
      new ApiError('node unavailable', 502, {
        data: { saved: true, applied: false },
      })
    )
    await invoke(slotOff(), 'onClick')
    await vi.waitFor(() =>
      expect(host.toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('telemetry.slotConfirmationFailed')
      )
    )
    expect(host.toast.error).not.toHaveBeenCalled()
    expect(slotOff().props.disabled).toBe(false)
    host.api.mockResolvedValue({ saved: true, applied: true })
    await invoke(slotOff(), 'onClick')
    await vi.waitFor(() => expect(host.toast.success).toHaveBeenCalled())
    expect(host.api).toHaveBeenCalledTimes(2)
  })

  it('includes unconfirmed same-value OFF in the bulk button, confirmation and API calls', async () => {
    const disableAll = find(
      pane(),
      (item) =>
        elements(item.props.children as ReactNode).some(
          (child) => child.props.i18nKey === 'telemetry.disableAll'
        ) && !!item.props.onClick
    )
    expect(disableAll.props.disabled).toBe(false)
    invoke(disableAll, 'onClick')
    const confirm = named(pane(), 'ConfirmDialog')
    const description = JSON.stringify(confirm.props.desc)
    expect(description).toContain('telemetry.confirmWrite')
    expect(description).toContain('count\\":1')
    invoke(confirm, 'handleConfirm')
    await vi.waitFor(() =>
      expect(host.toast.success).toHaveBeenCalledWith(
        expect.stringContaining('telemetry.batchDisabled')
      )
    )
    expect(host.api).toHaveBeenCalledTimes(1)
  })

  it('keeps published and partially saved bulk writes pending and counts real write failures separately', async () => {
    host.vms = ['vm-1', 'vm-2', 'vm-3'].map((id) => ({ ...host.vms[0], id }))
    host.api
      .mockResolvedValueOnce({ saved: true, published: true })
      .mockRejectedValueOnce(
        new ApiError('confirmation unavailable', 502, { data: { saved: true } })
      )
      .mockRejectedValueOnce(new Error('write failed'))
    const disableAll = find(
      pane(),
      (item) =>
        elements(item.props.children as ReactNode).some(
          (child) => child.props.i18nKey === 'telemetry.disableAll'
        ) && !!item.props.onClick
    )
    invoke(disableAll, 'onClick')
    invoke(named(pane(), 'ConfirmDialog'), 'handleConfirm')
    await vi.waitFor(() =>
      expect(host.toast.error).toHaveBeenCalledWith(
        'telemetry.batchDisableFailed {"count":0,"pending":2,"failed":1,"errors":"vm-3"}'
      )
    )
    expect(host.api).toHaveBeenCalledTimes(3)
    expect(host.toast.success).not.toHaveBeenCalled()
  })

  it('renders native batch/event/failure counts and sanitized error records for remote slots', () => {
    host.vms[0].node_id = 'node-1'
    host.logs = [
      JSON.stringify({
        at: '2026-10-31T12:00:00Z',
        ok: true,
        events: 2,
        error: null,
        payload: 'never-display',
      }),
      JSON.stringify({
        at: '2026-10-31T12:01:00Z',
        ok: false,
        events: 1,
        error: 'upload_failed',
      }),
    ]
    invoke(
      find(slotTree(), (item) => item.props['aria-expanded'] === false),
      'onClick'
    )
    const upload = expand(named(slotTree(), 'UploadPanel'))
    const stats = elements(upload).filter(
      (item) => typeof item.type === 'function' && item.type.name === 'Stat'
    )
    expect(
      stats.map((stat) => [stat.props.label, stat.props.children])
    ).toEqual(
      expect.arrayContaining([
        ['telemetry.batches', 2],
        ['telemetry.events', 3],
        ['failed', 1],
      ])
    )
    const raw = find(upload, (item) => item.type === 'pre').props.children
    expect(raw).toContain('upload_failed')
    expect(raw).not.toContain('never-display')
    const timeline = expand(named(upload, 'Timeline'))
    expect(
      elements(timeline)
        .map((item) => item.props.title)
        .filter(Boolean)
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('upload_failed')])
    )
  })
})

function detailCard() {
  resetHooks()
  const body = render(() => VmDetailPage())
  resetHooks()
  return named(
    render(() =>
      expand({ ...body, props: { ...body.props, tab: 'seed' } } as Element)
    ),
    'SeedPolicyCard'
  )
}
describe('detail page native seed mutation contract', () => {
  it.each([
    [{ saved: true }, 'warning', 'detailPage.seedSaved'],
    [{ saved: true, published: true }, 'info', 'detailPage.seedPublished'],
    [{ saved: true, applied: true }, 'success', 'detailPage.seedApplied'],
    [
      { saved: true, service: { supported: false } },
      'warning',
      'detailPage.seedUnsupported',
    ],
  ] as const)(
    'awaits the mutation and reports %j',
    async (result, tone, key) => {
      host.api.mockResolvedValue(result)
      const pending = invoke(detailCard(), 'onSave', { theme: 'light' })
      expect(pending).toBeInstanceOf(Promise)
      await pending
      expect(host.api).toHaveBeenCalledWith(
        '/api/panel/vms/vm-1/seed-settings',
        expect.objectContaining({ body: '{"theme":"light"}' })
      )
      expect(host.toast[tone]).toHaveBeenCalledWith(key)
      if (tone !== 'success') expect(host.toast.success).not.toHaveBeenCalled()
    }
  )
  it('propagates a saved-but-unconfirmed rejection and refreshes the policy without claiming applied', async () => {
    host.api.mockRejectedValue(
      new ApiError('node unavailable', 502, { data: { saved: true } })
    )
    await expect(invoke(detailCard(), 'onSave', {})).rejects.toThrow(
      'node unavailable'
    )
    expect(host.toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('detailPage.seedConfirmationFailed')
    )
    expect(host.invalidate).toHaveBeenCalledWith({
      queryKey: ['panel', 'vm', 'vm-1', 'seed'],
    })
    expect(host.toast.success).not.toHaveBeenCalled()
  })
  it('passes cached-query and upload failures to the seed component', () => {
    host.readError = new Error('stale seed')
    host.uploadError = new Error('node log unavailable')
    expect(detailCard().props).toMatchObject({
      readError: 'stale seed',
      uploadError: 'node log unavailable',
    })
  })
})

describe('seed save acknowledgment classification', () => {
  it('does not infer native application from saved or published policy', () => {
    expect(seedSaveState({ saved: true })).toBe('saved')
    expect(seedSaveState({ saved: true, published: true })).toBe('published')
    expect(seedSaveState({ saved: true, service: { applied: true } })).toBe(
      'applied'
    )
    expect(seedSaveState({})).toBe('unknown')
  })
})

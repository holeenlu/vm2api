import { useMemo, useState } from 'react'
import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/lib/api'
import { fmtResetClock, resetCountdown } from '@/lib/fable-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { type SlashCommand, WsTerminal } from '@/components/ws-terminal'
import { probeSourceLabel } from '@/features/vm/probe-status'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BAR = 20

type UsageWindow =
  | {
      /** 0–1 比例；后端已把官方 0–100 归一。 */
      utilization?: number | null
      resets_at?: string | number | null
      status?: string | null
    }
  | null
  | undefined

type UsageProbe = {
  ok?: boolean
  error?: string | null
  source?: string
  via?: string | null
  probed_at?: string
  account_tier?: string | null
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  seven_day_oi?: UsageWindow
  seven_day_sonnet?: UsageWindow
  extra_usage?: (NonNullable<UsageWindow> & { is_enabled?: boolean }) | null
}

type Step = {
  ok?: boolean
  skipped?: boolean
  reason?: string
  error?: string
} | null

function windowRow(label: string, w: UsageWindow): string {
  const head = `  ${label.padEnd(8)}`
  const ratio = Number(w?.utilization)
  if (w?.utilization == null || !Number.isFinite(ratio)) {
    return `${head}${DIM}—${RESET}`
  }
  const used = Math.max(0, Math.round(ratio * 100))
  const fill = Math.min(BAR, Math.round((used / 100) * BAR))
  const tone = used >= 90 ? RED : used >= 70 ? YELLOW : GREEN
  const bar = `${tone}${'█'.repeat(fill)}${DIM}${'░'.repeat(BAR - fill)}${RESET}`
  const reset = fmtResetClock(w.resets_at)
  const left = resetCountdown(w.resets_at)
  const tail = reset
    ? tVm('vm:vmShellCard.reset', {
        DIM: DIM,
        reset: reset,
        value1: left ? `（${left}）` : '',
        RESET: RESET,
      })
    : ''
  const status =
    w.status && w.status !== 'allowed' ? `  ${RED}${w.status}${RESET}` : ''
  return `${head}${bar} ${tone}${String(used).padStart(3)}%${RESET}${tail}${status}`
}

function usageLines(p: UsageProbe): string[] {
  const meta = [
    p.account_tier
      ? tVm('vm:vmShellCard.tier', { account_tier: p.account_tier })
      : null,
    tVm('vm:vmShellCard.source', {
      value1: probeSourceLabel(p.source),
      value2: p.via ? ` · ${p.via}` : '',
    }),
    fmtResetClock(p.probed_at),
  ]
    .filter(Boolean)
    .join(' · ')
  const lines = [
    `${DIM}${meta}${RESET}`,
    windowRow('5h', p.five_hour),
    windowRow('7d', p.seven_day),
  ]
  if (p.seven_day_oi) lines.push(windowRow('Fable', p.seven_day_oi))
  if (p.seven_day_sonnet) lines.push(windowRow('Sonnet', p.seven_day_sonnet))
  if (p.extra_usage?.is_enabled) lines.push(windowRow('Extra', p.extra_usage))
  if (p.ok === false || p.error) {
    lines.push(
      tVm('vm:vmShellCard.summary', {
        RED: RED,
        value1: p.error || tVm('vm:probeStatus.probeFailed'),
        RESET: RESET,
      })
    )
  }
  return lines
}

function stepText(s: Step | undefined): string {
  if (!s) return `${DIM}—${RESET}`
  if (s.skipped)
    return tVm('vm:vmShellCard.skipped', {
      DIM: DIM,
      value1: s.reason || '—',
      RESET: RESET,
    })
  if (s.ok === false)
    return tVm('vm:vmShellCard.summary', {
      RED: RED,
      value1: s.error || s.reason || tVm('vm:officialCcCard.failed'),
      RESET: RESET,
    })
  return `${GREEN}✓${RESET}${s.reason ? ` ${DIM}${s.reason}${RESET}` : ''}`
}

function flag(name: string, on?: boolean) {
  return `${name} ${on ? `${GREEN}✓${RESET}` : `${DIM}—${RESET}`}`
}

function postVm<T>(id: string, path: string) {
  return api<T>(`/api/panel/vms/${encodeURIComponent(id)}${path}`, {
    method: 'POST',
    body: '{}',
  })
}

/**
 * 运维 tab 的槽容器终端。默认不连：每次打开都会在槽里起一个 bash，
 * 只在运维真要用时才建。快捷指令走面板接口，与按钮同一条后端路径。
 */
export function VmShellCard({
  vm,
  onChanged,
}: {
  vm: Vm
  onChanged: () => void
}) {
  const { t: tVm } = useTranslation('vm')

  const [open, setOpen] = useState(false)
  const id = vm.id
  const container = String(
    (vm.runtime as Record<string, unknown> | undefined)?.container ||
      vm.container ||
      ''
  )

  const commands = useMemo<SlashCommand[]>(
    () => [
      {
        name: '/usage',
        desc: tVm('vm:vmShellCard.viewUsageSameAsProbe'),
        run: async () => {
          const probe = await postVm<UsageProbe>(id, '/probe')
          onChanged()
          return usageLines(probe)
        },
      },
      {
        name: '/wrap',
        desc: tVm('vm:vmShellCard.reinstallWrapCliAndRestartKernel'),
        run: async () => {
          const r = await postVm<{
            wrap?: {
              kernel_bin?: boolean
              wrapper?: boolean
              glibc_shim?: boolean
            }
            kernel?: Step
          }>(id, '/wrap-cli/repair')
          onChanged()
          return [
            `  wrap-cli  ${GREEN}✓${RESET} ${[
              flag('kin-kernel', r.wrap?.kernel_bin),
              flag('wrapper', r.wrap?.wrapper),
              flag('glibc shim', r.wrap?.glibc_shim),
            ].join(' · ')}`,
            `  kernel    ${stepText(r.kernel)}`,
          ]
        },
      },
      {
        name: '/reload',
        desc: tVm('vm:detailOpsTab.reloadWorker'),
        run: async () => {
          const r = await postVm<{ reload?: { rust?: Step } }>(id, '/reload')
          onChanged()
          return [
            `  worker    ${GREEN}✓${RESET}`,
            `  kernel    ${stepText(r.reload?.rust)}`,
          ]
        },
      },
    ],
    [id, onChanged, tVm]
  )

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm'>
          <Trans ns='vm' i18nKey='vmShellCard.terminal' />
        </CardTitle>
        {open ? (
          <Button
            size='sm'
            variant='ghost'
            className='h-7'
            onClick={() => setOpen(false)}
          >
            <Trans ns='vm' i18nKey='detailCircuitField.off' />
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className='pt-0'>
        {open ? (
          <div className='h-[420px]'>
            <WsTerminal
              ticketPath={`/api/panel/vms/${encodeURIComponent(id)}/shell-ticket`}
              socketPath={`/api/panel/vms/${encodeURIComponent(id)}/shell`}
              commands={commands}
            />
          </div>
        ) : (
          <div className='flex flex-wrap items-center gap-3'>
            <Button size='sm' variant='outline' onClick={() => setOpen(true)}>
              <Trans ns='vm' i18nKey='vmShellCard.openTerminal' />
            </Button>
            <span className='text-xs text-muted-foreground'>
              <Trans
                ns='vm'
                i18nKey='vmShellCard.openTheContainerSystemIdentityIsPrintedOnStartup'
                values={{ value: container || id }}
                components={{
                  part0: <span className='font-mono' />,
                  part1: <span className='font-mono' />,
                }}
              />
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

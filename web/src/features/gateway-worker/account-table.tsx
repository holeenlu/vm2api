import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import {
  Archive,
  BarChart3,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  UserRoundPlus,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { expiresAtToMs, fmtResetClock } from '@/lib/fable-status'
import { subscriptionListLabel } from '@/lib/subscription-expiry'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { fleetGroup } from '@/lib/vm-status'
import { vmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { CredLaneChip, SlotIdentity } from '@/components/platform-chip'
import {
  StatusBarOptions,
  useStatusBarShow,
} from '@/features/vm/status-bar-options'
import { VmCostLedger, VmUsageWindows } from '@/features/vm/usage-windows'
import { VM_COL_CLS as COL_CLS } from '@/features/vm/use-vm-column-order'
import { VmGroupLabels } from '@/features/vm/vm-groups'
import { RequestCell, StatusCell, TierBadge } from '@/features/vm/vm-list-table'
import type { GatewayAccount } from './accounts-model'

export type AccountRowAction =
  | 'detail'
  | 'stats'
  | 'edit'
  | 'groups'
  | 'authorize'
  | 'refresh'
  | 'recover'
  | 'test'
  | 'archive'

export type AccountRow = { account: GatewayAccount; vm: Vm }

const COLUMNS = [
  'vm',
  'groups',
  'sched',
  'type',
  'status',
  'req',
  'usage',
  'cost',
] as const

function AccountCell({ row, now }: { row: AccountRow; now: number }) {
  const { t } = useTranslation('common')
  const { account, vm } = row
  const sub = subscriptionListLabel(vm, now)
  return (
    <div className='min-w-0 space-y-0.5 overflow-hidden'>
      <SlotIdentity vm={vm} compact className='text-sm font-medium' />
      <div className='flex min-w-0 items-center gap-1.5'>
        <TierBadge vm={vm} />
        <span className='inline-flex shrink-0 items-center rounded-[5px] border border-border/70 px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em] text-muted-foreground'>
          {t('codexGatewayChip')}
        </span>
        <span
          className='min-w-0 truncate text-[11px] text-muted-foreground'
          title={account.name}
        >
          {account.name}
        </span>
      </div>
      <div
        className={cn(
          'truncate font-mono text-[11px] tabular-nums',
          sub.tone === 'bad' && 'text-[color:var(--status-bad)]',
          sub.tone === 'warn' && 'text-[color:var(--status-warn)]',
          sub.tone === 'muted' && 'text-muted-foreground'
        )}
        title={sub.title}
      >
        {sub.text}
      </div>
      <div className='truncate text-[10.5px] text-muted-foreground'>
        {account.vendor_name || t('codexPlatformOwned')}
      </div>
    </div>
  )
}

/** 与 VM 列表「类型」同列：调用形式 + 容量，下一行周窗口重置时刻。 */
function TypeCell({ row, now }: { row: AccountRow; now: number }) {
  const { t } = useTranslation(['common', 'vm'])
  const { account, vm } = row
  const resetAt = vm.reset_7d
  const clock = vm.has_token ? fmtResetClock(resetAt) : null
  const resetMs = clock ? expiresAtToMs(resetAt) : 0
  return (
    <div className='min-w-0 space-y-1'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1'>
        {vm.has_token ? (
          <CredLaneChip endpoint='oauth' />
        ) : (
          <span className='text-xs text-muted-foreground'>
            <Trans ns='vm' i18nKey='detailStatusBoard.noCredentials' />
          </span>
        )}
        <span
          className='inline-flex rounded border border-border/70 px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold text-muted-foreground tabular-nums'
          title={t('codexConcurrencyRpm')}
        >
          {account.config.max_concurrency ?? '—'} /{' '}
          {account.config.max_rpm || '∞'}
        </span>
      </div>
      {clock ? (
        <div
          className={cn(
            'font-mono text-[11px] tabular-nums',
            resetMs > 0 && resetMs <= now
              ? 'text-[color:var(--status-bad)]'
              : 'text-muted-foreground'
          )}
          title={t('vm:vmListTable.weeklyWindowResetTime')}
        >
          <Trans
            ns='vm'
            i18nKey='vmListTable.resets'
            values={{ value: clock.slice(0, 11) }}
          />
        </div>
      ) : null}
    </div>
  )
}

function ProxySummary({ account }: { account: GatewayAccount }) {
  const endpoint = account.config.proxy_endpoint
  if (!endpoint) return null
  let host = endpoint
  try {
    host = new URL(endpoint).host
  } catch {
    /* Keep the stored summary. */
  }
  return (
    <span
      className='inline-flex max-w-full min-w-0 items-center gap-1 truncate rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground'
      title={endpoint}
    >
      {host}
    </span>
  )
}

function RowMenu({
  row,
  busy,
  onAction,
}: {
  row: AccountRow
  busy: boolean
  onAction: (action: AccountRowAction, account: GatewayAccount) => void
}) {
  const { t } = useTranslation(['common', 'vm'])
  const { account } = row
  const live = account.status !== 'archived'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size='icon'
          variant='ghost'
          className='size-7 text-muted-foreground'
          aria-label={t('vm:vmActionMenu.moreActionsFor', {
            id: account.name,
          })}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className='size-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        className='w-44'
        onClick={(e) => e.stopPropagation()}
      >
        {live ? (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => onAction('test', account)}
          >
            <Trans
              ns='vm'
              i18nKey='vmActionMenu.testConnection'
              components={{
                part0: <Play className='text-[color:var(--status-ok)]' />,
              }}
            />
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onAction('stats', account)}>
          <Trans
            ns='vm'
            i18nKey='vmActionMenu.viewStatistics'
            components={{
              part0: (
                <BarChart3 className='text-[color:var(--tier-pro-solid)]' />
              ),
            }}
          />
        </DropdownMenuItem>
        {live ? (
          <>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => onAction('authorize', account)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.reauthorize'
                components={{ part0: <Link2 /> }}
              />
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy || !row.vm.has_token}
              onSelect={() => onAction('refresh', account)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.refreshToken'
                components={{ part0: <RefreshCw /> }}
              />
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => onAction('edit', account)}
            >
              <Pencil />
              {t('codexEdit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => onAction('groups', account)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.assignGroups'
                components={{ part0: <UserRoundPlus /> }}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => onAction('recover', account)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.restoreStatus'
                components={{ part0: <RotateCcw /> }}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant='destructive'
              disabled={busy}
              onSelect={() => onAction('archive', account)}
            >
              <Archive />
              {t('archiveAccount')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Codex 账号列表：列、单元格与 VM 列表的 GPT 行一致。 */
export function GatewayAccountTable({
  rows,
  selected,
  busy,
  onToggle,
  onToggleAll,
  onSchedule,
  onAction,
}: {
  rows: AccountRow[]
  selected: string[]
  busy: boolean
  onToggle: (id: string) => void
  onToggleAll: () => void
  onSchedule: (account: GatewayAccount, on: boolean) => void
  onAction: (action: AccountRowAction, account: GatewayAccount) => void
}) {
  const { t } = useTranslation(['common', 'vm'])
  const now = useNow()
  const statusBar = useStatusBarShow()
  const selectable = rows.filter((r) => r.account.status !== 'archived')
  const picked = selectable.filter((r) => selected.includes(r.account.id))
  const label: Record<(typeof COLUMNS)[number], string> = {
    vm: t('vm:detailAccountTab.account'),
    groups: t('vm:vmListTable.groups'),
    sched: t('vm:vmListTable.scheduling'),
    type: t('vm:detailAccountTab.type'),
    status: t('vm:detailAccountTab.status'),
    req: t('vm:vmListTable.today7DayRequests'),
    usage: t('vm:usageWindows.usageWindows'),
    cost: t('vm:vmListTable.costTotal'),
  }
  const cell = (key: (typeof COLUMNS)[number], row: AccountRow): ReactNode => {
    const { account, vm } = row
    switch (key) {
      case 'vm':
        return <AccountCell row={row} now={now} />
      case 'groups':
        return <VmGroupLabels vm={vm} />
      case 'sched':
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              aria-label={`${t('codexSchedule')} · ${account.name}`}
              disabled={busy || account.status === 'archived'}
              checked={account.status === 'active'}
              onCheckedChange={(checked) => onSchedule(account, checked)}
            />
          </div>
        )
      case 'type':
        return <TypeCell row={row} now={now} />
      case 'status':
        return (
          <StatusCell
            vm={vm}
            show={statusBar.show}
            now={now}
            proxy={<ProxySummary account={account} />}
          />
        )
      case 'req':
        return <RequestCell vm={vm} week={vmWeekOutcome(vm)} />
      case 'usage':
        return <VmUsageWindows vm={vm} now={now} quiet />
      case 'cost':
        return <VmCostLedger vm={vm} />
    }
  }
  return (
    <div className='overflow-x-auto rounded-lg border border-border/60'>
      <div className='min-w-[1300px]'>
        <div className='sticky top-0 z-10 flex h-8 items-center border-b bg-muted/30 pl-1.5 text-xs font-medium tracking-wide text-muted-foreground'>
          <div className='w-9 shrink-0 px-2'>
            <Checkbox
              checked={
                picked.length && picked.length === selectable.length
                  ? true
                  : picked.length
                    ? 'indeterminate'
                    : false
              }
              disabled={!selectable.length}
              aria-label={t('codexSelectAll', { count: selectable.length })}
              onCheckedChange={onToggleAll}
            />
          </div>
          {COLUMNS.map((key) => (
            <div
              key={key}
              className={cn(
                'flex items-center gap-0.5 px-1.5 py-1',
                COL_CLS[key]
              )}
            >
              <span className='truncate'>{label[key]}</span>
              {key === 'status' ? (
                <StatusBarOptions
                  show={statusBar.show}
                  onToggle={statusBar.toggle}
                />
              ) : null}
            </div>
          ))}
          <div className={COL_CLS.actions} />
        </div>
        {rows.map((row) => {
          const { account, vm } = row
          const group = fleetGroup(vm)
          const archived = account.status === 'archived'
          return (
            <div
              key={account.id}
              role='button'
              tabIndex={0}
              aria-label={`${t('codexDetails')} · ${account.name}`}
              className={cn(
                'group flex cursor-pointer items-start border-b border-border/40 py-2 pl-1.5 transition-colors duration-150 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                tierVisual(vm).row || 'hover:bg-accent/40',
                (group === 'off' || group === 'none') && 'opacity-60',
                selected.includes(account.id) && 'bg-accent/60'
              )}
              onClick={() => onAction('detail', account)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                onAction('detail', account)
              }}
            >
              <div
                className='w-9 shrink-0'
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <span className='inline-flex items-center p-1'>
                  <Checkbox
                    checked={selected.includes(account.id)}
                    disabled={archived}
                    aria-label={t('vm:vmBulk.selectOne', {
                      name: account.name,
                    })}
                    onCheckedChange={() => onToggle(account.id)}
                  />
                </span>
              </div>
              {COLUMNS.map((key) => (
                <div key={key} className={cn('px-1.5', COL_CLS[key])}>
                  {cell(key, row)}
                </div>
              ))}
              <div
                className={cn(COL_CLS.actions, 'flex justify-end')}
                onClick={(e) => e.stopPropagation()}
              >
                <RowMenu row={row} busy={busy} onAction={onAction} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

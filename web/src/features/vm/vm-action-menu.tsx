import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import {
  BarChart3,
  Download,
  LifeBuoy,
  Link2,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  UserRoundPlus,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { canRefreshCredential, credTypeOf } from '@/lib/cred-type'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { meQueryOptions } from '@/features/auth/queries'
import { restrictionTitle } from '@/features/vm/clear-restriction'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmPackageDialog } from '@/features/vm/vm-package-dialog'
import { useVmPerms } from '@/features/vm/vm-perms'

/** 无法刷新时给出原因，与详情页 refreshBlocked 文案一致。 */
export function refreshBlockedReason(vm: Vm): string {
  if (canRefreshCredential(vm)) return ''
  return credTypeOf(vm) === 'apikey'
    ? tVm('vm:detailPage.consoleAPIKeysCannotBeRefreshed')
    : tVm('vm:vmActionMenu.noRefreshTokenCannotRefresh')
}

/**
 * 行尾扩展菜单：测试链接 / 查看统计 / 重新授权 / 刷新令牌 / 恢复状态 / 恢复服务，
 * 破坏性操作（重置、删除）收在分隔线之后。
 */
export function VmActionMenu({
  vm,
  className,
}: {
  vm: Vm
  className?: string
}) {
  const { t: tVm } = useTranslation('vm')

  const actions = useVmActions()
  const me = useQuery(meQueryOptions())
  const [packOpen, setPackOpen] = useState(false)
  const blocked = refreshBlockedReason(vm)
  const restricted = restrictionTitle(vm)
  const admin = me.data?.role === 'admin'
  const perms = useVmPerms()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size='icon'
            variant='ghost'
            className={cn('size-7 text-muted-foreground', className)}
            aria-label={tVm('vm:vmActionMenu.moreActionsFor', { id: vm.id })}
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
          {perms.test ? (
            <DropdownMenuItem onSelect={() => actions.openTest(vm)}>
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.testConnection'
                components={{
                  part0: <Play className='text-[color:var(--status-ok)]' />,
                }}
              />
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => actions.openStats(vm)}>
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
          {perms.credential ? (
            <>
              <DropdownMenuItem onSelect={() => actions.openReauth(vm)}>
                <Trans
                  ns='vm'
                  i18nKey='vmActionMenu.reauthorize'
                  components={{ part0: <Link2 /> }}
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={Boolean(blocked) || actions.refreshingId === vm.id}
                title={blocked || undefined}
                onSelect={() => actions.refreshToken(vm)}
              >
                <Trans
                  ns='vm'
                  i18nKey='vmActionMenu.refreshToken'
                  components={{ part0: <RefreshCw /> }}
                />
              </DropdownMenuItem>
            </>
          ) : null}
          {admin ? (
            <DropdownMenuItem onSelect={() => setPackOpen(true)}>
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.exportJSONPackage'
                components={{ part0: <Download /> }}
              />
            </DropdownMenuItem>
          ) : null}
          {actions.openAssignGroups ? (
            <DropdownMenuItem
              disabled={actions.groupsBusyId === vm.id}
              onSelect={() => actions.openAssignGroups?.(vm)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.assignGroups'
                components={{ part0: <UserRoundPlus /> }}
              />
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!restricted || actions.recoveringId === vm.id}
            title={restricted ?? tVm('vm:vmActionMenu.noCooldownOrOpenCircuit')}
            onSelect={() => actions.recover(vm)}
          >
            <Trans
              ns='vm'
              i18nKey='vmActionMenu.restoreStatus'
              components={{ part0: <RotateCcw /> }}
            />
          </DropdownMenuItem>
          {perms.power ? (
            <DropdownMenuItem onSelect={() => actions.openRecovery(vm)}>
              <Trans
                ns='vm'
                i18nKey='testChatResultCard.recoverService'
                components={{ part0: <LifeBuoy /> }}
              />
            </DropdownMenuItem>
          ) : null}
          {actions.reset || actions.remove ? <DropdownMenuSeparator /> : null}
          {actions.reset ? (
            <DropdownMenuItem onSelect={() => actions.reset?.(vm)}>
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.resetSlot'
                components={{ part0: <RotateCcw /> }}
              />
            </DropdownMenuItem>
          ) : null}
          {actions.remove ? (
            <DropdownMenuItem
              variant='destructive'
              onSelect={() => actions.remove?.(vm)}
            >
              <Trans
                ns='vm'
                i18nKey='vmActionMenu.delete'
                components={{ part0: <Trash2 /> }}
              />
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {admin ? (
        <VmPackageDialog
          vmId={vm.id}
          open={packOpen}
          onOpenChange={setPackOpen}
        />
      ) : null}
    </>
  )
}

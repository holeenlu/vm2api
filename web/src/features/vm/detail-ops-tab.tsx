import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { type CredType, credTypeLabel } from '@/lib/cred-type'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ChoiceTiles } from '@/components/choice-tiles'
import { Field } from '@/features/vm/detail-section-primitives'
import { VmEnvironmentCard } from '@/features/vm/environment-card'
import { NodeChip } from '@/features/vm/node-chip'
import { VmPhysicalFeaturesCard } from '@/features/vm/physical-features-card'
import { isRemoteVm, remoteUnsupportedText } from '@/features/vm/placement'
import { VmGroupsCard } from '@/features/vm/vm-groups'
import { VmShellCard } from '@/features/vm/vm-shell-card'

type VmOpsTabProps = {
  vm: Vm
  proxy: VmProxySnap
  officialCc: boolean
  credType: CredType
  canRefresh: boolean
  refreshBlocked: string
  savingTimezone: boolean
  onAction: (path: string, body?: unknown) => void
  /** 该路径的操作正在进行。 */
  busy: (path: string) => boolean
  /** 终端快捷指令执行后刷新详情。 */
  onRefresh: () => void
  onTimezoneSave: (timezone: string) => void
  onTimezoneFollowProxy: () => void
  onReset: () => void
  onDelete: () => void
}

export function VmOpsTab(props: VmOpsTabProps) {
  const { t: tVm } = useTranslation('vm')

  const [kernelOpen, setKernelOpen] = useState(false)
  const [kernelMode, setKernelMode] = useState<'keep' | 'traits'>('keep')
  const {
    vm,
    proxy,
    officialCc,
    credType,
    canRefresh,
    refreshBlocked,
    savingTimezone,
    onAction,
    busy,
    onRefresh,
    onTimezoneSave,
    onTimezoneFollowProxy,
    onReset,
    onDelete,
  } = props

  const gpt = isCodexVm(vm)
  const remote = isRemoteVm(vm)
  return (
    <TabsContent value='ops' className='space-y-3 pt-4'>
      <VmGroupsCard vm={vm} />
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>
            <Trans ns='vm' i18nKey='detailOpsTab.container' />
          </CardTitle>
        </CardHeader>
        <CardContent className='divide-y pt-0'>
          <Field label={tVm('vm:detailOpsTab.server')}>
            <NodeChip nodeId={vm.node_id} className='text-[11px]' />
          </Field>
          <Field label={tVm('vm:detailOpsTab.container')}>
            <span className='font-mono text-xs'>
              {String(
                (vm.runtime as Record<string, unknown> | undefined)
                  ?.container ||
                  vm.container ||
                  '—'
              )}
            </span>
          </Field>
          {(vm.runtime as Record<string, unknown> | undefined)
            ?.egress_container ? (
            <Field label={tVm('vm:detailOpsTab.egressContainer')}>
              <span className='font-mono text-xs'>
                {String(
                  (vm.runtime as Record<string, unknown>).egress_container
                )}
              </span>
            </Field>
          ) : null}
          <Field label={tVm('vm:labels.guest')}>
            <span className='font-mono text-xs'>
              {String(
                (vm.fingerprint as Record<string, unknown> | undefined)
                  ?.hostname || tVm('vm:detailOpsTab.notCollected')
              )}
            </span>
          </Field>
        </CardContent>
      </Card>
      <VmPhysicalFeaturesCard
        vm={vm}
        collecting={busy('/collect-identity')}
        onCollect={() => onAction('/collect-identity')}
      />
      <VmEnvironmentCard
        vm={vm}
        proxy={proxy}
        saving={savingTimezone}
        onSave={onTimezoneSave}
        onFollowProxy={onTimezoneFollowProxy}
      />
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          loading={busy('/activate')}
          onClick={() => onAction('/activate')}
        >
          <Trans ns='vm' i18nKey='detailOpsTab.setActive' />
        </Button>
        <Button
          size='sm'
          variant='outline'
          loading={busy('/reload')}
          onClick={() => onAction('/reload')}
        >
          {gpt
            ? tVm('vm:detailOpsTab.reloadCodexKernel')
            : tVm('vm:detailOpsTab.reloadWorker')}
        </Button>
        <Button
          size='sm'
          variant='outline'
          loading={busy('/collect-identity')}
          onClick={() => onAction('/collect-identity')}
        >
          <Trans ns='vm' i18nKey='detailOpsTab.collectIdentity' />
        </Button>
        {gpt ? null : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!officialCc || remote}
                    loading={busy('/official-cc-bootstrap')}
                    onClick={() =>
                      onAction('/official-cc-bootstrap', {
                        force: true,
                        manual: true,
                      })
                    }
                  >
                    <Trans ns='vm' i18nKey='detailOpsTab.runOfficialSetup' />
                  </Button>
                </span>
              </TooltipTrigger>
              {remote ? (
                <TooltipContent>{remoteUnsupportedText()}</TooltipContent>
              ) : !officialCc ? (
                <TooltipContent>
                  <Trans
                    ns='vm'
                    i18nKey='detailOpsTab.officialSetupRequiresFullOAuthCredentialsThisSlotUses'
                    values={{ credTypeLabel: credTypeLabel(credType) }}
                  />
                </TooltipContent>
              ) : null}
            </Tooltip>
            <Button
              size='sm'
              variant='outline'
              loading={busy('/reconcile-fingerprint')}
              onClick={() => onAction('/reconcile-fingerprint', {})}
            >
              <Trans ns='vm' i18nKey='detailOpsTab.alignOfficialFingerprint' />
            </Button>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                size='sm'
                variant='outline'
                disabled={!canRefresh}
                loading={busy('/oauth/refresh')}
                onClick={() => onAction('/oauth/refresh', {})}
              >
                <Trans ns='vm' i18nKey='detailAccountTab.refreshCredentials' />
              </Button>
            </span>
          </TooltipTrigger>
          {refreshBlocked ? (
            <TooltipContent>{refreshBlocked}</TooltipContent>
          ) : null}
        </Tooltip>
      </div>
      {gpt ? null : (
        <>
          <Separator />
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={remote}
              loading={busy('/wrap-cli/promote')}
              onClick={() => onAction('/wrap-cli/promote')}
            >
              <Trans ns='vm' i18nKey='detailOpsTab.promoteToSeed' />
            </Button>
            <Button
              size='sm'
              variant='outline'
              loading={busy('/wrap-cli/repair')}
              onClick={() => setKernelOpen(true)}
            >
              <Trans ns='vm' i18nKey='detailOpsTab.reinstallKernel' />
            </Button>
          </div>
        </>
      )}
      {gpt ? null : <VmShellCard vm={vm} onChanged={onRefresh} />}
      <Separator />
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' variant='outline' onClick={onReset}>
          <Trans ns='vm' i18nKey='detailOpsTab.reset' />
        </Button>
        <Button size='sm' variant='destructive' onClick={onDelete}>
          <Trans ns='vm' i18nKey='detailOpsTab.deleteThisSlot' />
        </Button>
      </div>
      <Dialog open={kernelOpen} onOpenChange={setKernelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans ns='vm' i18nKey='detailOpsTab.reinstallKernel' />
            </DialogTitle>
          </DialogHeader>
          <ChoiceTiles
            label={tVm('vm:detailOpsTab.updateMethod')}
            value={kernelMode}
            onChange={setKernelMode}
            choices={[
              {
                value: 'keep',
                title: tVm('vm:detailOpsTab.rebuildWithExistingData'),
                detail: tVm(
                  'vm:detailOpsTab.keepsCredentialsFingerprintsAndStatisticsReplacesOnlyKernelCli'
                ),
              },
              {
                value: 'traits',
                title: tVm('vm:detailOpsTab.rebuildWithNewIdentity'),
                detail: remote
                  ? tVm(
                      'vm:detailOpsTab.clusterSlotsOnlyReplaceTheImageTheRemoteHome'
                    )
                  : tVm(
                      'vm:detailOpsTab.clearsTheHomeDirectoryAndGeneratesANewMachine'
                    ),
              },
            ]}
          />
          <DialogFooter>
            <Button variant='outline' onClick={() => setKernelOpen(false)}>
              <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
            </Button>
            <Button
              variant={kernelMode === 'traits' ? 'destructive' : 'default'}
              onClick={() => {
                setKernelOpen(false)
                onAction('/wrap-cli/repair', { mode: kernelMode })
              }}
            >
              {kernelMode === 'keep'
                ? tVm('vm:detailOpsTab.rebuildWithExistingData')
                : tVm('vm:detailOpsTab.rebuildWithNewIdentity')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabsContent>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { catalogForVm, isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { meQueryOptions } from '@/features/auth/queries'
import { modelPolicyQueryOptions } from '@/features/models/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from '@/features/vm/queries'
import { matchesAllowedModel, toggleAllowedModel } from './allowed-models'

type CatalogItem = { id: string; label: string; family?: string }

type PolicyPayload = {
  policy?: {
    models?: Record<
      string,
      {
        enabled?: boolean
        display_name?: string
        family?: string
        sort?: number
      }
    >
  }
  models?: { id: string; label?: string; display_name?: string }[]
}

function isFableId(id: string) {
  return /fable/i.test(String(id || ''))
}

function catalogFrom(data: PolicyPayload | undefined): CatalogItem[] {
  const pol = data?.policy?.models
  if (pol && Object.keys(pol).length) {
    return Object.entries(pol)
      .filter(([, cfg]) => cfg && cfg.enabled !== false)
      .map(([id, cfg]) => ({
        id,
        label: cfg.display_name || id,
        family: cfg.family || '',
        sort: Number(cfg.sort) || 100,
      }))
      .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
      .map(({ id, label, family }) => ({ id, label, family }))
  }
  return (data?.models || []).map((m) => ({
    id: m.id,
    label: m.label || m.display_name || m.id,
    family: isFableId(m.id) ? 'fable' : '',
  }))
}

function allowedListOf(vm: Vm): string[] | null {
  const a = vm.allowed_models
  return Array.isArray(a) && a.length ? a : null
}

function isChecked(vm: Vm, id: string) {
  if (isFableId(id) && claudeTier(vm).key === 'pro') return false
  const allowed = allowedListOf(vm)
  if (!allowed) return true
  return allowed.some((a) => matchesAllowedModel(id, a))
}

export function AllowedModelsCard({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const canEdit = me.data?.role === 'super_admin'
  const pro = claudeTier(vm).key === 'pro'
  const inherit = !allowedListOf(vm)
  const gpt = isCodexVm(vm)

  // model-policy 只有管理员能读；其他角色只看本槽已存的白名单。
  const policy = useQuery({
    ...modelPolicyQueryOptions(gpt ? 'openai' : 'anthropic'),
    enabled: canEdit,
  })
  const items = catalogForVm(catalogFrom(policy.data), vm)
  const save = useMutation({
    mutationFn: (next: string[] | null) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ allowed_models: next }),
      }),
    onSuccess: (_r, next) => {
      toast.success(
        next?.length
          ? tVm('vm:allowedModelsCard.modelRestrictionsSaved')
          : tVm('vm:allowedModelsCard.allModelsRestored')
      )
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey })
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (e: Error) =>
      toast.error(
        e.message || tVm('vm:allowedModelsCard.failedToSaveModelAllowlist')
      ),
  })

  const toggle = (id: string, checked: boolean) => {
    const current = allowedListOf(vm)
    let next: string[]
    if (!current) {
      next = items
        .map((m) => m.id)
        .filter((mid) => {
          if (pro && isFableId(mid)) return false
          if (mid === id) return checked
          return true
        })
    } else {
      next = toggleAllowedModel(current, id, checked)
      if (pro) next = next.filter((a) => !isFableId(a))
    }
    // selecting everything is the same as inheriting — store null, not a full list
    const expected = items
      .filter((m) => !(pro && isFableId(m.id)))
      .map((m) => m.id)
    const covers =
      expected.length &&
      expected.every((mid) => next.some((a) => matchesAllowedModel(mid, a)))
    save.mutate(covers ? null : next)
  }

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>
          <Trans ns='vm' i18nKey='allowedModelsCard.modelAllowlist' />
        </CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <p className='text-xs text-muted-foreground'>
          {inherit
            ? gpt
              ? tVm('vm:allowedModelsCard.unrestrictedFollowsTheGPTModelMatrix')
              : tVm(
                  'vm:allowedModelsCard.unrestrictedFollowsTheGlobalModelMatrix'
                )
            : tVm('vm:allowedModelsCard.onlyTheseModelsCanUseThisCredential')}
          {pro && !gpt
            ? tVm('vm:allowedModelsCard.fableIsUnavailableForProAccounts')
            : ''}
        </p>
        {!canEdit ? (
          inherit ? null : (
            <p className='font-mono text-xs break-all'>
              {allowedListOf(vm)?.join(' · ')}
            </p>
          )
        ) : policy.isLoading ? (
          <p className='text-xs text-muted-foreground'>
            <Trans ns='vm' i18nKey='allowedModelsCard.loadingModelMatrix' />
          </p>
        ) : items.length ? (
          <div className='flex flex-wrap gap-x-4 gap-y-2'>
            {items.map((m) => {
              const locked = pro && isFableId(m.id)
              const id = `slot-model-${m.id}`
              return (
                <div key={m.id} className='flex items-center gap-2'>
                  <Checkbox
                    id={id}
                    checked={isChecked(vm, m.id)}
                    disabled={locked || !canEdit || save.isPending}
                    onCheckedChange={(v) => toggle(m.id, v === true)}
                  />
                  <Label
                    htmlFor={id}
                    className='text-xs font-normal data-[disabled]:opacity-60'
                  >
                    {m.label}
                  </Label>
                </div>
              )
            })}
          </div>
        ) : (
          <p className='text-xs text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='allowedModelsCard.modelMatrixNotLoadedSyncItOnTheModels'
            />
          </p>
        )}
        {canEdit ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={inherit || save.isPending}
            onClick={() => save.mutate(null)}
          >
            {save.isPending
              ? tVm('vm:allowedModelsCard.saving')
              : tVm('vm:allowedModelsCard.selectAllInherit')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

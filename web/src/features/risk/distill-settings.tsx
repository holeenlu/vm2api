import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DistillRules } from '@/types/panel-routing'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/features/settings/save-bar'
import { Fold, FoldStack, Group, ToggleItem, ToggleList } from './blocks'
import { distillQueryOptions } from './queries'

function linesOf(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function fingerprintsOf(text: string) {
  return text
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function DistillSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const { t: translate } = useTranslation('risk')

  const qc = useQueryClient()
  const q = useQuery(distillQueryOptions())
  const [draft, setDraft] = useState<DistillRules | null>(null)
  const [hardText, setHardText] = useState('')
  const [needlesText, setNeedlesText] = useState('')
  const [patternsText, setPatternsText] = useState('')
  const [fpText, setFpText] = useState('')

  const load = (data: DistillRules) => {
    setDraft({
      ...data,
      hard_needles: data.hard_needles || [],
      skip_zero: data.skip_zero !== false,
      structure: {
        ...data.structure,
        contest_pattern: data.structure?.contest_pattern || '',
      },
    })
    setHardText((data.hard_needles || []).join('\n'))
    setNeedlesText(data.needles.join('\n'))
    setPatternsText((data.patterns || []).join('\n'))
    setFpText(data.fingerprints.join('\n---\n'))
  }
  useEffect(() => {
    if (q.data) load(q.data)
  }, [q.data])

  const dirty =
    !!draft &&
    JSON.stringify({
      ...draft,
      hard_needles: linesOf(hardText),
      needles: linesOf(needlesText),
      patterns: linesOf(patternsText),
      fingerprints: fingerprintsOf(fpText),
    }) !== JSON.stringify({ ...q.data, skip_zero: q.data?.skip_zero !== false })
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () =>
      api<DistillRules>('/api/panel/distill', {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          hard_needles: linesOf(hardText),
          needles: linesOf(needlesText),
          patterns: linesOf(patternsText),
          fingerprints: fingerprintsOf(fpText),
        }),
      }),
    onSuccess: (data) => {
      toast.success(translate('risk:distillSaved'))
      qc.setQueryData(distillQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft) return <div className='h-40 animate-pulse bg-muted/40' />

  const patch = (next: Partial<DistillRules>) => setDraft({ ...draft, ...next })
  const patchError = (next: Partial<DistillRules['error']>) =>
    patch({ error: { ...draft.error, ...next } })
  const patchStructure = (next: Partial<DistillRules['structure']>) =>
    patch({ structure: { ...draft.structure, ...next } })

  const hardCount = linesOf(hardText).length
  const needleCount = linesOf(needlesText).length
  const patternCount = linesOf(patternsText).length
  const fpCount = fingerprintsOf(fpText).length

  return (
    <div className='space-y-8 p-4'>
      <Group
        title={translate('risk:whenToBlock')}
        hint={translate('risk:distillOpenaiBypass')}
      >
        <ToggleList>
          <ToggleItem
            label={translate('risk:blockDistillation')}
            desc={translate('risk:distillDisableHint')}
          >
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:allowOfficialClients')}
            desc={translate('risk:harvestStillBlocked')}
          >
            <Switch
              checked={draft.skip_official}
              onCheckedChange={(v) => patch({ skip_official: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:allowZeroInjection')}
            desc={translate('risk:refusalCacheStillApplies')}
          >
            <Switch
              checked={draft.skip_zero !== false}
              onCheckedChange={(v) => patch({ skip_zero: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:structureWithoutTools')}
            desc={translate('risk:toolsNotHarvesting')}
          >
            <Switch
              checked={draft.structure.require_no_tools}
              onCheckedChange={(v) => patchStructure({ require_no_tools: v })}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:singleTurnStructure')}
            desc={translate('risk:multiTurnNotHarvesting')}
          >
            <Switch
              checked={draft.structure.require_single_turn}
              onCheckedChange={(v) =>
                patchStructure({ require_single_turn: v })
              }
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:structureTokenMinimum')}
            desc={translate('risk:structureMinimumHint')}
          >
            <Input
              aria-label={translate('risk:structureTokenMinimum')}
              className='w-24 text-right tabular-nums'
              type='number'
              min={1}
              value={draft.structure.min_max_tokens}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (!Number.isFinite(value) || value <= 0) return
                patchStructure({ min_max_tokens: Math.floor(value) })
              }}
            />
          </ToggleItem>
          <ToggleItem
            label={translate('risk:contestStructureRegex')}
            desc={translate('risk:contestRegexEmptyHint')}
          >
            <Input
              aria-label={translate('risk:contestStructureRegex')}
              className='w-72 font-mono text-xs'
              value={draft.structure.contest_pattern}
              onChange={(e) =>
                patchStructure({ contest_pattern: e.target.value })
              }
            />
          </ToggleItem>
        </ToggleList>
      </Group>

      <Group
        title={translate('risk:rules')}
        hint={translate('risk:regexFalsePositiveHint')}
      >
        <FoldStack>
          <Fold
            flush
            title={translate('risk:harvestingWrappers')}
            meta={
              hardCount
                ? translate('risk:itemCount', { count: hardCount })
                : translate('risk:noneYet')
            }
          >
            <p className='mb-2 text-xs text-muted-foreground'>
              {translate('risk:wrapperHint')}
            </p>
            <Textarea
              aria-label={translate('risk:harvestingWrappers')}
              className='min-h-36 font-mono text-xs'
              value={hardText}
              onChange={(e) => setHardText(e.target.value)}
            />
          </Fold>
          <Fold
            flush
            title={translate('risk:blockingTemplates')}
            meta={
              needleCount
                ? translate('risk:itemCount', { count: needleCount })
                : translate('risk:noneYet')
            }
          >
            <p className='mb-2 text-xs text-muted-foreground'>
              {translate('risk:onePerLineSentence')}
            </p>
            <Textarea
              aria-label={translate('risk:blockingTemplates')}
              className='min-h-36 font-mono text-xs'
              value={needlesText}
              onChange={(e) => setNeedlesText(e.target.value)}
            />
          </Fold>
          <Fold
            flush
            title={translate('risk:extraRegex')}
            meta={
              patternCount
                ? translate('risk:itemCount', { count: patternCount })
                : translate('risk:noneYet')
            }
          >
            <p className='mb-2 text-xs text-muted-foreground'>
              {translate('risk:extraRegexHint')}
            </p>
            <Textarea
              aria-label={translate('risk:extraRegex')}
              className='min-h-36 font-mono text-xs'
              value={patternsText}
              onChange={(e) => setPatternsText(e.target.value)}
            />
          </Fold>
          <Fold
            flush
            title={translate('risk:questionFingerprints')}
            meta={
              fpCount
                ? translate('risk:questionCount', { count: fpCount })
                : translate('risk:noneYet')
            }
          >
            <p className='mb-2 text-xs text-muted-foreground'>
              {translate('risk:fingerprintHint')}
            </p>
            <Textarea
              aria-label={translate('risk:questionFingerprints')}
              className='min-h-36 font-mono text-xs'
              value={fpText}
              onChange={(e) => setFpText(e.target.value)}
            />
          </Fold>
        </FoldStack>
      </Group>

      <Group title={translate('risk:clientResponse')}>
        <div className='grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]'>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-status'>
              {translate('risk:httpStatus')}
            </Label>
            <Input
              id='distill-status'
              type='number'
              min={400}
              max={599}
              value={draft.error.status}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (!Number.isFinite(value)) return
                patchError({ status: Math.floor(value) })
              }}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-code'>{translate('risk:errorCode')}</Label>
            <Input
              id='distill-code'
              className='font-mono'
              value={draft.error.code}
              onChange={(e) => patchError({ code: e.target.value })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-type'>{translate('risk:errorType')}</Label>
            <Input
              id='distill-type'
              className='font-mono'
              value={draft.error.type}
              onChange={(e) => patchError({ type: e.target.value })}
            />
          </div>
          <div className='space-y-1.5 sm:col-span-3'>
            <Label htmlFor='distill-message'>
              {translate('risk:responseMessage')}
            </Label>
            <Input
              id='distill-message'
              value={draft.error.message}
              onChange={(e) => patchError({ message: e.target.value })}
            />
          </div>
        </div>
      </Group>

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => q.data && load(q.data)}
        />
      ) : null}
    </div>
  )
}

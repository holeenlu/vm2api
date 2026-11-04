import { useEffect, useMemo, useState } from 'react'
import { t as tr } from '@/i18n'
import type { PersonaPreset } from '@/types/panel-routing'
import { Check, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESETS,
  PERSONA_TEMPLATE_VARS,
  formatLineError,
  parsePersonaTemplateLines,
  personaPresetFromCompat,
  presetSeed,
  stringifyPersonaTemplate,
  validatePersonaTemplate,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  type PersonaDrafts,
  personaDraftStoresEmpty,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import {
  Notice,
  PersonaTemplateEditor,
  Problems,
} from '@/features/settings/persona-editors'
import { systemPresetLabel } from './preset-label'
import { PromptFields } from './prompt-fields'
import {
  promptDisplayText,
  promptEditorBlocks,
  promptSourceBlocks,
  promptSourceText,
} from './prompt-presentation'
import { SystemPreview } from './system-preview'

type Compat = Record<string, unknown>

/** 草稿能解析就用草稿块，否则（空 / 有错）用后端会回落到的内置模板。 */
function effectiveBlocks(text: string, preset: PersonaPreset): RawBlock[] {
  const { blocks, errors } = parsePersonaTemplateLines(text)
  if (!errors.length && blocks.length) return blocks
  return presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
}

function PresetBar({
  active,
  viewing,
  summaries,
  onView,
}: {
  active: PersonaPreset
  viewing: PersonaPreset
  summaries: Record<PersonaPreset, string>
  onView: (preset: PersonaPreset) => void
}) {
  const { t } = useTranslation('system')

  return (
    <div
      role='tablist'
      aria-label={t('system:presetSelector')}
      className='grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5'
    >
      {PERSONA_PRESETS.map((key) => {
        const label = systemPresetLabel(key)
        const selected = key === viewing
        return (
          <button
            key={key}
            type='button'
            role='tab'
            aria-selected={selected}
            onClick={() => onView(key)}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              selected
                ? 'border-primary/50 bg-primary/5'
                : 'border-border/60 bg-card hover:border-border hover:bg-muted/40'
            )}
          >
            <span className='w-full text-sm font-medium whitespace-nowrap'>
              {label}
            </span>
            <span className='flex w-full items-center gap-2 text-[11px] text-muted-foreground'>
              <span>{summaries[key]}</span>
              {key === active ? (
                <span className='ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium whitespace-nowrap text-emerald-600 dark:text-emerald-400'>
                  <Check className='size-3' aria-hidden />
                  {t('system:active')}
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
export function SystemPromptWorkspace({
  compat,
  server,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  server: Compat | undefined
  onChange: (next: Compat) => void
  onProblemsChange: (problems: string[]) => void
}) {
  const { t } = useTranslation('system')

  const [drafts, setDrafts] = useState<PersonaDrafts | null>(null)
  const active = personaPresetFromCompat(compat)
  const [viewing, setViewing] = useState<PersonaPreset>(active)

  useEffect(() => {
    if (drafts || !Object.keys(compat).length) return
    setDrafts(seedPersonaDrafts(compat))
    setViewing(personaPresetFromCompat(compat))
  }, [compat, drafts])

  const problems = useMemo(() => {
    if (!drafts) return []
    const out: string[] = []
    for (const key of PERSONA_PRESETS) {
      const messageKey =
        key === active ? 'system:templateError' : 'system:presetTemplateError'
      const parsed = parsePersonaTemplateLines(drafts[key])
      for (const err of parsed.errors)
        out.push(
          t(messageKey, {
            preset: systemPresetLabel(key),
            error: formatLineError(err),
          })
        )
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(t(messageKey, { preset: systemPresetLabel(key), error: msg }))
    }
    return out
  }, [drafts, active, t])

  useEffect(() => {
    onProblemsChange(problems)
  }, [problems, onProblemsChange])

  if (!drafts) {
    return (
      <p className='text-sm text-muted-foreground'>{t('system:loading')}</p>
    )
  }

  const setDraft = (text: string) => {
    const next = { ...drafts, [viewing]: text }
    setDrafts(next)
    onChange({ ...compat, persona_templates: personaTemplatesPayload(next) })
  }

  const text = drafts[viewing]
  const parsed = parsePersonaTemplateLines(text)
  const hasErrors = parsed.errors.length > 0
  const blocks = effectiveBlocks(text, viewing)
  const summaries = Object.fromEntries(
    PERSONA_PRESETS.map((key) => [key, personaSchemeSummary(drafts[key], key)])
  ) as Record<PersonaPreset, string>

  return (
    <div className='space-y-4'>
      <PresetBar
        active={active}
        viewing={viewing}
        summaries={summaries}
        onView={setViewing}
      />

      <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]'>
        <section
          aria-label={tr('system:sync14008OutboundPreview')}
          className='min-w-0 xl:sticky xl:top-20'
        >
          <SystemPreview preset={viewing} blocks={blocks} compat={compat} />
        </section>
        <aside
          aria-label={tr('system:sync14008InjectionControls')}
          className='min-w-0 space-y-4'
        >
          {viewing !== active ? (
            <div className='flex items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-2.5'>
              <span className='text-sm text-muted-foreground'>
                {t('system:viewingPreset', {
                  viewing: systemPresetLabel(viewing),
                  active: systemPresetLabel(active),
                })}
              </span>
              <Button
                type='button'
                size='sm'
                className='cursor-pointer'
                onClick={() =>
                  onChange({
                    ...compat,
                    persona_preset: viewing,
                    persona_templates: personaTemplatesPayload(drafts),
                  })
                }
              >
                {t('system:activate')}
              </Button>
            </div>
          ) : null}

          <Card className='gap-0 py-0'>
            <div className='flex items-center justify-between gap-2 px-5 py-4 sm:px-6'>
              <span className='text-base font-semibold'>
                {tr('system:sync14008InjectionControls')}
              </span>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 cursor-pointer text-xs'
                onClick={() =>
                  setDraft(
                    stringifyPersonaTemplate(
                      presetSeed(DEFAULT_PERSONA_TEMPLATES, viewing)
                    )
                  )
                }
              >
                <RotateCcw />
                {tr('system:restorePreset')}
              </Button>
            </div>
            <div className='space-y-3 border-t border-border/60 px-5 py-4 sm:px-6'>
              {viewing === 'custom' &&
              personaDraftStoresEmpty(text, 'custom') ? (
                <Notice tone='caution'>{tr('system:emptyTemplateHint')}</Notice>
              ) : null}
              {viewing === 'custom' || hasErrors ? (
                <details className='group'>
                  <summary className='cursor-pointer py-2 text-sm font-medium focus-visible:rounded-md'>
                    {tr('system:sync14008DetailedEditor')}
                  </summary>
                  <div className='pt-3'>
                    <PersonaTemplateEditor
                      key={viewing}
                      text={
                        hasErrors
                          ? promptDisplayText(text)
                          : stringifyPersonaTemplate(
                              promptEditorBlocks(parsed.blocks)
                            )
                      }
                      blocks={promptEditorBlocks(blocks)}
                      hasErrors={hasErrors}
                      vars={PERSONA_TEMPLATE_VARS.map(([name, description]) => [
                        promptDisplayText(`{{${name}}}`).slice(2, -2),
                        description.replace(/2\.1\.303/g, '').trim(),
                      ])}
                      onTextChange={(next) => {
                        const source = promptSourceText(next)
                        const parsed = parsePersonaTemplateLines(source)
                        setDraft(
                          parsed.errors.length
                            ? source
                            : stringifyPersonaTemplate(
                                promptSourceBlocks(parsed.blocks, blocks)
                              )
                        )
                      }}
                      onBlocksChange={(next) =>
                        setDraft(
                          stringifyPersonaTemplate(
                            promptSourceBlocks(next, blocks)
                          )
                        )
                      }
                    />
                  </div>
                </details>
              ) : (
                <PromptFields
                  preset={viewing}
                  blocks={blocks}
                  compat={compat}
                  server={server}
                  onBlocksChange={(next) =>
                    setDraft(stringifyPersonaTemplate(next))
                  }
                  onCompatChange={onChange}
                />
              )}
            </div>
          </Card>

          <Problems items={problems} />
        </aside>
      </div>
    </div>
  )
}

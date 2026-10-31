import { t as tr } from '@/i18n'
import type { RawBlock } from '@/lib/persona-template'

const VARIABLES: Record<string, string> = {
  main_prompt_303: 'official_prompt',
  harness_303: 'official_harness',
  guidance_303: 'official_guidance',
  env_303: 'environment',
  env_instructions_303: 'environment_instructions',
  env_timezone: 'slot_timezone',
  env_locale: 'slot_locale',
}

const LABEL_KEYS: Record<string, string> = {
  billing: 'system:sync14008BlocksBilling',
  identity: 'system:sync14008BlocksIdentity',
  harness: 'system:sync14008BlocksHarness',
  guidance: 'system:sync14008BlocksGuidance',
  dynamic_boundary: 'system:sync14008BlocksDynamicBoundary',
  caller_system: 'system:sync14008BlocksCallerSystem',
  env: 'system:sync14008BlocksEnv',
  env_official: 'system:sync14008BlocksEnvOfficial',
  env_extra: 'system:sync14008BlocksEnvExtra',
  env_instructions: 'system:sync14008BlocksEnvInstructions',
  env_timezone: 'system:sync14008BlocksEnvTimezone',
  env_locale: 'system:sync14008BlocksEnvLocale',
  custom: 'system:sync14008BlocksCustom',
}
export function promptBlockLabel(id: string): [string, string] {
  const key = LABEL_KEYS[id] || LABEL_KEYS.custom
  return [tr(key + 'Label'), tr(key + 'Description')]
}

// Display aliases never reach the gateway; saved templates keep its canonical variables.
export function promptDisplayText(text: string): string {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(VARIABLES, name.toLowerCase())
      ? `{{${VARIABLES[name.toLowerCase()]}}}`
      : match
  )
}

export function promptSourceText(text: string): string {
  const sources = Object.fromEntries(
    Object.entries(VARIABLES).map(([source, display]) => [display, source])
  )
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(sources, name.toLowerCase())
      ? `{{${sources[name.toLowerCase()]}}}`
      : match
  )
}

function displayNote(note: string): string {
  return note.replace(/2\.1\.303\s*/g, '').trim()
}

export function promptEditorBlocks(blocks: RawBlock[]): RawBlock[] {
  return blocks.map((block) => ({
    ...block,
    ...(typeof block.note === 'string'
      ? { note: displayNote(block.note) }
      : {}),
    text: promptDisplayText(String(block.text ?? '')),
  }))
}

export function promptSourceBlocks(
  blocks: RawBlock[],
  original: RawBlock[]
): RawBlock[] {
  return blocks.map((block, index) => {
    const previous =
      block.id == null
        ? original[index]
        : original.find((item) => item.id === block.id)
    // Presentation-only notes must not turn an unchanged preset into a saved override.
    const restoreNote =
      typeof previous?.note === 'string' &&
      block.note === displayNote(previous.note)
    return {
      ...block,
      ...(restoreNote ? { note: previous.note } : {}),
      text: promptSourceText(String(block.text ?? '')),
    }
  })
}

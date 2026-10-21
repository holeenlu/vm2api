import { t as tVm } from '@/i18n'

export type SlotPersonaPreset =
  'inherit' | 'official' | 'official_full' | 'zero'

const SLOT_LABELS: Record<SlotPersonaPreset, string> = {
  get inherit() {
    return tVm('vm:personaContract.followGlobal')
  },
  get official() {
    return tVm('vm:personaContract.officialPrompt')
  },
  get official_full() {
    return tVm('vm:personaContract.fullOfficialPrompt')
  },
  get zero() {
    return tVm('vm:personaContract.noInjection')
  },
}

export const SLOT_PERSONA_OPTIONS: {
  value: SlotPersonaPreset
  label: string
}[] = (Object.keys(SLOT_LABELS) as SlotPersonaPreset[]).map((value) => ({
  value,
  get label() {
    return SLOT_LABELS[value]
  },
}))

export function normalizeSlotPersonaPreset(
  value: unknown,
  fallback: SlotPersonaPreset = 'inherit'
): SlotPersonaPreset {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') {
    return 'inherit'
  }
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') {
    return 'official_full'
  }
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  ) {
    return 'official'
  }
  if (
    raw === 'zero' ||
    raw === 'zero_inject' ||
    raw === '0inject' ||
    raw === '0-inject'
  ) {
    return 'zero'
  }
  return fallback
}

/** Gateway PATCH: empty string means inherit the settings-page preset. */
export function slotPersonaPatchValue(value: SlotPersonaPreset) {
  return value === 'inherit' ? '' : value
}

export function slotPersonaLabel(value: SlotPersonaPreset | null | undefined) {
  return (value && SLOT_LABELS[value]) || SLOT_LABELS.inherit
}

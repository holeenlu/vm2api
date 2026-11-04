import { t } from '@/i18n'
import type { PersonaPreset } from '@/types/panel-routing'

const PRESET_LABEL_KEYS: Record<PersonaPreset, string> = {
  official: 'system:presetOfficial',
  official_full: 'system:presetOfficialFull',
  zero: 'system:presetZero',
  custom: 'system:presetCustom',
}

export function systemPresetLabel(preset: PersonaPreset): string {
  return t(PRESET_LABEL_KEYS[preset])
}

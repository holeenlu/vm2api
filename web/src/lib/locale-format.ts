import { i18n, t } from '@/i18n'

/** Read the selected UI language on every call, including after a language switch. */
export function localeNumber(
  value: number,
  options: Intl.NumberFormatOptions = {}
): string {
  return value.toLocaleString(i18n.resolvedLanguage, options)
}

/** Preserve the caller's precision and compact layout; never change currency or units. */
export function fixedNumber(value: number, digits: number): string {
  return localeNumber(Number(value.toFixed(digits)), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  })
}

/** Existing tuple consumers read the label on access; option IDs remain stable. */
export function localizedOption<T extends string>(
  value: T,
  key: string
): [T, string] {
  return Object.defineProperty([value, ''], '1', {
    get: () => t('lib:' + key),
  }) as [T, string]
}

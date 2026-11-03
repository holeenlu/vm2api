import { t } from '@/i18n'

/** Keep option IDs stable while resolving their display labels in the current language. */
export function localizedOption<
  Value extends string | number,
  Extra extends unknown[],
>(value: Value, key: string, ...extra: Extra): [Value, string, ...Extra] {
  const option: [Value, string, ...Extra] = [value, '', ...extra]
  Object.defineProperty(option, 1, {
    enumerable: true,
    get: () => t(key),
  })
  return option
}

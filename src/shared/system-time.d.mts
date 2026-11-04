export const SYSTEM_TIMEZONE: 'Asia/Shanghai'
export const SYSTEM_TIMEZONE_LABEL: 'UTC+8'
export function systemDateTime(value?: Date | number | string): string
export function systemDate(value?: Date | number | string): string
export function systemDayStartMs(value?: Date | number | string, dayOffset?: number): number
export function systemDateTimeToIso(value: string): string

import { systemDate, systemDateTimeToIso } from '@/lib/system-time'
import { dateRangeValueForPreset } from '@/components/date-range-picker'

// The operations report follows the shared UTC+8 calendar.
export function supplierUsagePreset(
  preset: Parameters<typeof dateRangeValueForPreset>[0],
  now = new Date()
) {
  const dates = dateRangeValueForPreset(preset, now)
  return { startDate: dates.startDate!, endDate: dates.endDate! }
}

export function supplierUsageQueryString(
  selectedQuery: string,
  now = new Date()
) {
  const params = new URLSearchParams(selectedQuery)
  const endDate = params.get('end_date') || ''
  params.set('start_date', systemDateTimeToIso(params.get('start_date')!))
  params.delete('end_date')
  // An omitted end is resolved to the server's current time on every request.
  // Past calendar selections include the whole end day using an exclusive bound.
  if (endDate < systemDate(now)) {
    const end = new Date(systemDateTimeToIso(endDate))
    end.setUTCDate(end.getUTCDate() + 1)
    params.set('end_date', end.toISOString())
  }
  return params.toString()
}

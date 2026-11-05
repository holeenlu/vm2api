import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { SingleDatePicker } from '@/components/date-range-picker'

type DatePickerProps = {
  selected: Date | undefined
  onSelect: (date: Date | undefined) => void
  placeholder?: string
}

export function DatePicker({
  selected,
  onSelect,
  placeholder = t('common:pickDate'),
}: DatePickerProps) {
  useTranslation('common')
  const value = selected
    ? `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, '0')}-${String(selected.getDate()).padStart(2, '0')}`
    : ''
  return (
    <SingleDatePicker
      value={value}
      onChange={(next) => {
        if (!next) {
          onSelect(undefined)
          return
        }
        const [year, month, day] = next.split('-').map(Number)
        onSelect(new Date(year, month - 1, day))
      }}
      labels={{
        empty: placeholder,
        clear: t('common:reset'),
        cancel: t('common:cancel'),
        confirm: t('common:confirm'),
        selectRange: placeholder,
      }}
      disableFuture
    />
  )
}

import { DropdownMenuTrigger } from '@radix-ui/react-dropdown-menu'
import { MixerHorizontalIcon } from '@radix-ui/react-icons'
import { type Table } from '@tanstack/react-table'
import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

type DataTableViewOptionsProps<TData> = {
  table: Table<TData>
}

export function DataTableViewOptions<TData>({
  table,
}: DataTableViewOptionsProps<TData>) {
  useTranslation('common')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='ms-auto hidden h-8 lg:flex'
        >
          <MixerHorizontalIcon className='size-4' />
          {t('common:view')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-37.5'>
        <DropdownMenuLabel>{t('common:toggleColumns')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table
          .getAllColumns()
          .filter(
            (column) =>
              typeof column.accessorFn !== 'undefined' && column.getCanHide()
          )
          .map((column) => {
            return (
              <DropdownMenuCheckboxItem
                key={column.id}
                className='capitalize'
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(!!value)}
              >
                {column.id}
              </DropdownMenuCheckboxItem>
            )
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import type { ResourcePermission } from '@/types/panel-auth'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import {
  RESOURCE_PERMISSIONS,
  toggleResourcePermission,
} from '@/features/auth/resource-permissions'

const KEY: Record<ResourcePermission, string> = {
  'resources.read': 'read',
  'resources.create': 'create',
  'resources.edit': 'edit',
  'resources.manage': 'manage',
}

const levelKey = (level: string) =>
  'resourcePermissions' + level[0].toUpperCase() + level.slice(1)

/** 超级管理员给管理员勾选账号资源能力；勾选自动补齐隐含能力。 */
export function ResourcePermissionGrants({
  value,
  onChange,
}: {
  value: ResourcePermission[]
  onChange: (next: ResourcePermission[]) => void
}) {
  const { t } = useTranslation('users')
  return (
    <fieldset className='space-y-3 rounded-md border p-4'>
      <legend className='px-1 text-sm font-medium'>
        {t('resourcePermissionsTitle')}
      </legend>
      <p className='text-xs leading-5 text-muted-foreground'>
        {t('resourcePermissionsHelp')}
      </p>
      <div className='grid gap-3 sm:grid-cols-2'>
        {RESOURCE_PERMISSIONS.map((cap) => {
          const id = 'resource-permission-' + KEY[cap]
          return (
            <label
              key={cap}
              htmlFor={id}
              className='flex items-start gap-2 rounded-md border p-3 text-sm has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5'
            >
              <Checkbox
                id={id}
                className='mt-0.5'
                checked={value.includes(cap)}
                onCheckedChange={(on) =>
                  onChange(toggleResourcePermission(value, cap, on === true))
                }
              />
              <span className='min-w-0'>
                <span className='block font-medium'>
                  {t(levelKey(KEY[cap]))}
                </span>
                <span className='block text-xs leading-5 text-muted-foreground'>
                  {t(levelKey(KEY[cap]) + 'Help')}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

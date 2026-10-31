import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as translate } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, api, panelFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  backupConfigQueryOptions,
  backupsQueryOptions,
} from '@/features/settings/queries'
import { RawConfigFields } from '@/features/settings/raw-config-fields'

export function BackupPane() {
  const { t } = useTranslation('settings')

  const qc = useQueryClient()
  const list = useQuery(backupsQueryOptions())
  const cfg = useQuery(backupConfigQueryOptions())
  const [restoreId, setRestoreId] = useState('')
  const create = useMutation({
    mutationFn: () => api('/api/panel/backups', { method: 'POST', body: '{}' }),
    onSuccess: async () => {
      toast.success(t('backup.created'))
      await qc.invalidateQueries({ queryKey: backupsQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const items = list.data?.items || []

  async function download(id: string) {
    const res = await panelFetch(
      `/api/panel/backups/${encodeURIComponent(id)}/download`
    )
    if (!res.ok)
      throw new ApiError(
        translate('settings:backup.downloadFailed'),
        res.status
      )
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `backup-${id}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle>{t('backup.title')}</CardTitle>
        <Button
          size='sm'
          onClick={() => create.mutate()}
          disabled={create.isPending}
          loading={create.isPending}
        >
          {t('create')}
        </Button>
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-sm text-muted-foreground'>
          {t('backup.restoreHint')}
        </p>
        <RawConfigFields
          value={cfg.data as Record<string, unknown> | undefined}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t('time')}</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((b) => (
              <TableRow key={b.id}>
                <TableCell className='font-mono text-xs'>{b.id}</TableCell>
                <TableCell>{b.created_at || '—'}</TableCell>
                <TableCell className='space-x-1'>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      download(b.id).catch((e: Error) => toast.error(e.message))
                    }
                  >
                    {t('download')}
                  </Button>
                  <Button
                    size='sm'
                    variant='destructive'
                    onClick={() => setRestoreId(b.id)}
                  >
                    {t('restore')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ConfirmDialog
          open={!!restoreId}
          onOpenChange={() => setRestoreId('')}
          title={t('backup.confirmTitle')}
          desc={t('backup.confirmDescription')}
          confirmText={t('backup.confirmRestore')}
          cancelBtnText={t('cancel')}
          destructive
          handleConfirm={() => {
            api(`/api/panel/backups/${encodeURIComponent(restoreId)}/restore`, {
              method: 'POST',
              body: JSON.stringify({ confirm: true }),
            })
              .then(async () => {
                toast.success(t('backup.restoring'))
                setRestoreId('')
                await qc.invalidateQueries({ queryKey: ['panel'] })
              })
              .catch((e: Error) => toast.error(e.message))
          }}
        />
      </CardContent>
    </Card>
  )
}

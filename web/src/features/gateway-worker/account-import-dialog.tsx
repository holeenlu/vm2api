import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { idempotencyKey } from '@/lib/idempotency-key'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { QueryGate } from '@/components/query-gate'
import type { ImportResult } from './account-transfer'
import { accountBase, type GatewayCatalog } from './accounts-model'

const selectClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm'

/** 导入账号文件（由“导出账号文件”生成）：逐个新建账号并导入原生与 BPS 授权，分组与代理按本部署选择。 */
export function GatewayAccountImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => Promise<unknown>
}) {
  const { t } = useTranslation(['common', 'vendor'])
  const catalog = useQuery({
    queryKey: ['gateway-account-catalog'],
    queryFn: () => api<GatewayCatalog>(`${accountBase}/catalog`),
  })
  const [file, setFile] = useState<{ accounts?: unknown[] } | null>(null)
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [proxyId, setProxyId] = useState('file')
  const [key] = useState(idempotencyKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  async function read(selected: File | undefined) {
    setError('')
    setFile(null)
    if (!selected) return
    try {
      const parsed = JSON.parse(await selected.text())
      if (parsed?.type !== 'kin-gateway-accounts')
        throw new Error(t('codexImportFileInvalid'))
      setFile(parsed)
    } catch (e) {
      setError((e as Error).message || t('codexImportFileInvalid'))
    }
  }
  async function submit() {
    if (!file) return setError(t('codexImportFileInvalid'))
    if (!groupIds.length) return setError(t('codexImportGroupRequired'))
    setBusy(true)
    setError('')
    try {
      const data = await api<ImportResult>(`${accountBase}/import-file`, {
        method: 'POST',
        body: JSON.stringify({
          file,
          group_ids: groupIds,
          idempotency_key: key,
          ...(proxyId === 'file' ? {} : { proxy_id: proxyId }),
        }),
      })
      setResult(data)
      await onImported()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className='max-h-[90dvh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>{t('codexImportTitle')}</DialogTitle>
          <DialogDescription>{t('codexImportDescription')}</DialogDescription>
        </DialogHeader>
        <QueryGate loading={catalog.isPending} error={catalog.error}>
          <fieldset disabled={busy || !!result} className='space-y-4'>
            <Input
              type='file'
              accept='application/json,.json'
              aria-label={t('codexImportFile')}
              onChange={(event) => void read(event.target.files?.[0])}
            />
            {file ? (
              <p className='text-xs text-muted-foreground'>
                {t('codexImportCount', { count: file.accounts?.length || 0 })}
              </p>
            ) : null}
            <div className='space-y-2'>
              <p className='text-sm font-medium'>{t('codexImportGroups')}</p>
              <div className='grid gap-2 sm:grid-cols-2'>
                {catalog.data?.groups.map((group) => (
                  <label
                    key={group.id}
                    className='flex items-center gap-2 rounded-md border p-2 text-sm'
                  >
                    <Checkbox
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(on) =>
                        setGroupIds((ids) =>
                          on === true
                            ? [...ids, group.id]
                            : ids.filter((id) => id !== group.id)
                        )
                      }
                    />
                    {group.name}
                  </label>
                ))}
              </div>
            </div>
            <label className='grid gap-1 text-sm font-medium'>
              {t('vendor:proxy')}
              <select
                className={selectClass}
                value={proxyId}
                onChange={(event) => setProxyId(event.target.value)}
              >
                <option value='file'>{t('codexImportProxyFromFile')}</option>
                {catalog.data?.proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.name || `${proxy.host}:${proxy.port}`}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        </QueryGate>
        {result ? (
          <ul className='space-y-1 text-sm'>
            {result.items.map((item) => (
              <li
                key={item.index}
                className={item.ok ? 'text-emerald-600' : 'text-destructive'}
              >
                {item.name || `#${item.index + 1}`}：
                {item.ok
                  ? item.bps === 'authorized'
                    ? t('codexImportOkBps')
                    : t('codexImportOk')
                  : item.error?.message || t('codexActionFailed')}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            {result ? t('close') : t('cancel')}
          </Button>
          {result ? null : (
            <Button disabled={busy || !file} onClick={() => void submit()}>
              {t('codexImportSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

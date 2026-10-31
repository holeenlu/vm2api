import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchSelect } from '@/components/search-select'
import {
  catalogReasoningEffort,
  CODEX_REMOTE_MAX_BYTES,
  fetchCodexCatalog,
  modelCatalogUrl,
  type CatalogMode,
} from './codex-catalog'
import {
  connectionClients,
  connectionFiles,
  type Client,
  type Shell,
} from './connection-config'

function downloadFile(content: string, filename: string, type = 'text/plain') {
  const url = URL.createObjectURL(
    new Blob([content], { type: `${type};charset=utf-8` })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function UseKeyDialog({
  value,
  onClose,
}: {
  value: { id: string; name: string; key: string }
  onClose: () => void
}) {
  const { t } = useTranslation('keys')

  const q = useQuery({
    queryKey: ['panel', 'api-keys', value.id, 'connection'],
    queryFn: () =>
      api<{
        base_url: string | null
        platform: string
        websocket: boolean
        standalone_search: boolean
        models: { id: string; name: string }[]
      }>(`/api/panel/api-keys/${value.id}/connection`),
  })
  const [chosenClient, setClient] = useState<Client>()
  const clients = q.data
    ? connectionClients(q.data.platform, q.data.websocket)
    : []
  const client =
    clients.find((c) => c.id === chosenClient)?.id || clients[0]?.id || 'curl'
  const [chosenShell, setShell] = useState<Shell>('unix')
  const [chosen, setChosen] = useState<string>()
  const [catalogMode, setCatalogMode] = useState<CatalogMode>('remote')
  const isCodex = client === 'codex' || client === 'codex-ws'
  const shell = isCodex && chosenShell !== 'unix' ? 'cmd' : chosenShell
  const shells: { id: Shell; label: string }[] = isCodex
    ? [
        { id: 'unix', label: 'macOS / Linux' },
        { id: 'cmd', label: 'Windows' },
      ]
    : [
        { id: 'unix', label: 'macOS / Linux' },
        { id: 'powershell', label: 'PowerShell' },
        { id: 'cmd', label: 'Windows CMD' },
      ]
  const base = q.data?.base_url || window.location.origin
  // The dialog owns a revealed key snapshot; its catalog is discarded on close. Keep credentials out of cache identifiers.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const catalog = useQuery({
    queryKey: ['panel', 'api-keys', value.id, 'codex-catalog', base],
    queryFn: ({ signal }) => fetchCodexCatalog(base, value.key, signal),
    enabled: isCodex && Boolean(q.data && value.key),
    staleTime: 60000,
    retry: false,
    gcTime: 0,
  })
  const oversized = (catalog.data?.responseBytes || 0) > CODEX_REMOTE_MAX_BYTES
  const effectiveCatalogMode = oversized ? 'file' : catalogMode
  const connectionModels = (q.data?.models || []).filter((m) =>
    q.data?.platform === 'all' && client === 'claude'
      ? m.id.startsWith('claude-')
      : true
  )
  const models = isCodex
    ? (catalog.data?.models || [])
        .filter((m) => !m.visibility || m.visibility === 'list')
        .map((m) => ({ id: m.slug, name: m.display_name || m.slug }))
    : connectionModels
  const model = models.find((m) => m.id === chosen)?.id || models[0]?.id || ''
  const platform =
    q.data?.platform === 'all'
      ? model.startsWith('claude-')
        ? 'anthropic'
        : 'openai'
      : q.data?.platform || 'openai'
  const files = model
    ? connectionFiles({
        client,
        shell,
        base,
        key: value.key,
        model,
        platform,
        catalogMode: effectiveCatalogMode,
        reasoningEffort: catalogReasoningEffort(
          catalog.data?.models.find((m) => m.slug === model)
        ),
        standaloneSearch: Boolean(
          q.data?.standalone_search && platform === 'openai'
        ),
      })
    : []
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('keys:useTitle', { name: value.name })}</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          {t('keys:apiAddress', { base })}
        </p>
        <div
          className='flex flex-wrap gap-2'
          role='group'
          aria-label={t('keys:client')}
        >
          {clients.map((c) => (
            <Button
              type='button'
              key={c.id}
              variant={client === c.id ? 'default' : 'outline'}
              aria-pressed={client === c.id}
              onClick={() => setClient(c.id)}
            >
              {client === c.id && <Check aria-hidden='true' />}
              {c.label}
            </Button>
          ))}
        </div>
        {clients.length > 0 && client !== 'opencode' && (
          <div
            className='flex flex-wrap gap-2'
            role='group'
            aria-label={t('keys:os')}
          >
            {shells.map((os) => (
              <Button
                type='button'
                key={os.id}
                size='sm'
                variant={shell === os.id ? 'default' : 'outline'}
                aria-pressed={shell === os.id}
                onClick={() => setShell(os.id)}
              >
                {shell === os.id && <Check aria-hidden='true' />}
                {os.label}
              </Button>
            ))}
          </div>
        )}
        <SearchSelect
          value={model}
          options={models}
          label={t('keys:connectionModel')}
          searchPlaceholder={t('keys:searchModels')}
          onChange={setChosen}
        />
        {isCodex && (
          <section className='space-y-3 rounded-lg border bg-muted/30 p-4'>
            <h3 className='text-sm font-semibold'>{t('keys:apiKeyMode')}</h3>
            <label className='grid gap-1 text-sm'>
              {t('keys:openaiCatalog')}
              <select
                className='h-10 rounded-md border bg-background px-3'
                value={effectiveCatalogMode}
                onChange={(e) => setCatalogMode(e.target.value as CatalogMode)}
              >
                <option value='remote' disabled={oversized}>
                  {t('keys:remoteCatalog')}
                </option>
                <option value='file'>{t('keys:localFile')}</option>
              </select>
            </label>
            <code className='block text-xs break-all'>
              {effectiveCatalogMode === 'remote'
                ? modelCatalogUrl(base)
                : shell === 'unix'
                  ? '~/.codex/codex-models.json'
                  : '%USERPROFILE%/.codex/codex-models.json'}
            </code>
            <p className='text-xs text-muted-foreground'>
              {t('keys:catalogHelp')}
            </p>
            {oversized && (
              <p className='text-xs text-amber-600'>
                {t('keys:catalogOversized')}
              </p>
            )}
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={catalog.isFetching}
                onClick={() => void catalog.refetch()}
              >
                {catalog.isFetching
                  ? t('keys:fetching')
                  : catalog.error
                    ? t('keys:retryCatalog')
                    : catalog.data
                      ? t('keys:refreshCatalog')
                      : t('keys:fetchCatalog')}
              </Button>
              <Button
                type='button'
                size='sm'
                disabled={!catalog.data?.models.length}
                onClick={() =>
                  catalog.data &&
                  downloadFile(
                    catalog.data.content,
                    'codex-models.json',
                    'application/json'
                  )
                }
              >
                {t('keys:downloadCatalog')}
              </Button>
              {catalog.data && (
                <span className='text-xs text-muted-foreground'>
                  {t('keys:modelsFetched', {
                    count: catalog.data.models.length,
                  })}
                </span>
              )}
            </div>
            {catalog.error && (
              <p role='alert' className='text-sm text-destructive'>
                {catalog.error.message}{' '}
                {catalog.data
                  ? t('keys:catalogRetained')
                  : t('keys:catalogRequired')}
              </p>
            )}
          </section>
        )}
        {q.error && <p role='alert'>{q.error.message}</p>}
        {!q.isLoading &&
          !model &&
          (!isCodex || (!catalog.isFetching && !catalog.error)) && (
            <p className='text-sm text-muted-foreground'>
              {isCodex ? t('keys:noCodexModels') : t('keys:noModels')}
            </p>
          )}
        {files.map((file) => (
          <section key={file.path} className='overflow-hidden rounded border'>
            <div className='flex items-center justify-between gap-2 bg-muted px-3 py-2 text-sm'>
              <code>{file.path}</code>
              <div>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={async () => {
                    if (await copyText(file.content))
                      toast.success(t('keys:copied'))
                    else toast.error(t('keys:copyFailed'))
                  }}
                >
                  {t('keys:copy')}
                </Button>
                {file.downloadName && (
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() =>
                      downloadFile(file.content, file.downloadName!)
                    }
                  >
                    {t('keys:download')}
                  </Button>
                )}
              </div>
            </div>
            <pre className='overflow-auto p-3 text-xs break-all whitespace-pre-wrap'>
              {file.content}
            </pre>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}

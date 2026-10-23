import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { Copy, ExternalLink, Upload } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { CommitResult } from '@/features/vm/credential-panel'
import { vmQueryOptions } from '@/features/vm/queries'

type CodexImportMode = 'oauth' | 'access_token' | 'refresh_token' | 'json'

const MODES: { id: CodexImportMode; label: string }[] = [
  { id: 'oauth', label: 'OAuth' },
  {
    id: 'json',
    get label() {
      return tVm('vm:codexCredentialPanel.accountFile')
    },
  },
]

type Link = {
  sessionId: string
  authUrl: string
  expiresAt: number
  proxyHint: string
}

const EMPTY_LINK: Link = {
  sessionId: '',
  authUrl: '',
  expiresAt: 0,
  proxyHint: '',
}

function Seg({
  value,
  onChange,
  disabled,
}: {
  value: CodexImportMode
  onChange: (next: CodexImportMode) => void
  disabled?: boolean
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div
      role='tablist'
      aria-label={tVm('vm:codexCredentialPanel.addAccountUsing')}
      className='flex flex-wrap items-center gap-1.5'
    >
      {MODES.map((option) => (
        <Button
          key={option.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === option.id}
          disabled={disabled}
          variant={value === option.id ? 'default' : 'outline'}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  useTranslation('vm')

  return <p className='text-xs text-muted-foreground'>{children}</p>
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`
}

function useCountdown(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function CodexCredentialPanel({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<CodexImportMode>('oauth')
  const [text, setText] = useState('')
  const [code, setCode] = useState('')
  const [link, setLink] = useState<Link>(EMPTY_LINK)
  const [fileError, setFileError] = useState('')
  const [pickedFile, setPickedFile] = useState<{
    name: string
    size: number
  } | null>(null)

  const remaining = useCountdown(link.expiresAt)
  const linkReady = !!(link.sessionId && link.authUrl)
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyNamedLabel(vm.proxy) : '')

  useEffect(() => {
    setText('')
    setCode('')
    setLink(EMPTY_LINK)
    setFileError('')
    setPickedFile(null)
  }, [vm.id, mode])

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
    ])

  const importCred = useMutation({
    mutationFn: () =>
      api<CommitResult>('/api/panel/vms/import', {
        method: 'POST',
        body: JSON.stringify({
          vm_id: vm.id,
          type: 'codex',
          mode,
          auth_json: text,
        }),
      }),
    onSuccess: async (data) => {
      setText('')
      setFileError('')
      setPickedFile(null)
      await invalidate()
      toast.success(tVm('vm:codexCredentialPanel.gPTOAuthImported'))
      onCommitted?.(
        data,
        vm.id,
        tVm('vm:codexCredentialPanel.gPTOAuthImported')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const gen = useMutation({
    mutationFn: () =>
      api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
      }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/generate-auth-url`,
        {
          method: 'POST',
          body: JSON.stringify({ flavor: 'codex' }),
        }
      ),
    onSuccess: (data) => {
      setLink({
        sessionId: String(data.session_id || ''),
        authUrl: String(data.auth_url || ''),
        expiresAt: Number(data.expires_at) || 0,
        proxyHint: String(data.proxy_hint || ''),
      })
      setCode('')
      toast.success(tVm('vm:codexCredentialPanel.authorizationLinkGenerated'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const exchange = useMutation({
    mutationFn: () =>
      api<CommitResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/exchange-code`,
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: link.sessionId,
            code: code.trim(),
            flavor: 'codex',
          }),
        }
      ),
    onSuccess: async (data) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      toast.success(tVm('vm:codexCredentialPanel.codexOAuthCompleted'))
      onCommitted?.(
        data,
        vm.id,
        tVm('vm:codexCredentialPanel.codexOAuthCompleted')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = importCred.isPending || gen.isPending || exchange.isPending
  const placeholder = tVm(
    'vm:codexCredentialPanel.pasteOrUploadCodexCLICodexAuthJsonA'
  )

  async function onPickFile(file: File | undefined) {
    setFileError('')
    if (!file) return
    try {
      const raw = await file.text()
      setText(raw)
      setPickedFile({ name: file.name, size: file.size })
    } catch {
      setPickedFile(null)
      setFileError('vm:codexCredentialPanel.failedToReadFile')
    }
  }

  return (
    <div className='space-y-3'>
      <Hint>
        <Trans
          ns='vm'
          i18nKey='codexCredentialPanel.useCodexDesktopOAuthOrAnAccountFileAuth'
        />
      </Hint>
      <Seg value={mode} onChange={setMode} disabled={busy} />
      {mode === 'oauth' ? (
        linkReady ? (
          <div className='space-y-2'>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  void copyText(link.authUrl)
                    .catch(() => false)
                    .then((copied) => {
                      if (copied) {
                        toast.success(
                          tVm('vm:codexCredentialPanel.authorizationLinkCopied')
                        )
                      } else {
                        toast.error(
                          tVm(
                            'vm:codexCredentialPanel.copyFailedSelectTheLinkManually'
                          )
                        )
                      }
                    })
                }}
              >
                <Trans
                  ns='vm'
                  i18nKey='codexCredentialPanel.copyLink'
                  components={{
                    part0: <Copy className='size-3.5' aria-hidden='true' />,
                  }}
                />
              </Button>
              <a
                className='inline-flex items-center gap-1 text-xs underline'
                href={link.authUrl}
                target='_blank'
                rel='noreferrer'
              >
                <Trans
                  ns='vm'
                  i18nKey='codexCredentialPanel.openAuthorizationPage'
                  components={{
                    part0: (
                      <ExternalLink className='size-3' aria-hidden='true' />
                    ),
                  }}
                />
              </a>
            </div>
            <p className='text-xs break-all text-muted-foreground'>
              {link.authUrl}
            </p>
            <p className='text-xs text-muted-foreground tabular-nums'>
              <Trans
                ns='vm'
                i18nKey='codexCredentialPanel.validFor'
                values={{
                  remaining: remaining,
                  value: proxyHint
                    ? tVm('vm:codexCredentialPanel.via', {
                        proxyHint: proxyHint,
                      })
                    : '',
                }}
              />
            </p>
            <div className='space-y-1'>
              <Label htmlFor='codex-oauth-callback'>
                <Trans ns='vm' i18nKey='codexCredentialPanel.callbackURL' />
              </Label>
              <Textarea
                id='codex-oauth-callback'
                rows={3}
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
                placeholder='http://localhost:1455/auth/callback?code=...&state=...'
              />
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                disabled={!code.trim() || busy}
                loading={exchange.isPending}
                onClick={() => exchange.mutate()}
              >
                {exchange.isPending
                  ? tVm('vm:codexCredentialPanel.verifying')
                  : tVm('vm:codexCredentialPanel.completeAuthorization')}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                loading={gen.isPending}
                onClick={() => gen.mutate()}
              >
                <Trans ns='vm' i18nKey='codexCredentialPanel.regenerate' />
              </Button>
            </div>
            <Hint>
              <Trans
                ns='vm'
                i18nKey='codexCredentialPanel.routeTheBrowserThroughAfterAuthorizationPasteTheEntire'
                values={{
                  value: proxyHint || tVm('vm:codexCredentialPanel.slotSOCKS5'),
                }}
              />
            </Hint>
          </div>
        ) : (
          <div className='space-y-2'>
            <Hint>
              <Trans
                ns='vm'
                i18nKey='codexCredentialPanel.generateAnOfficialCodexDesktopAuthorizationLinkTokenExchange'
              />
            </Hint>
            <Button
              size='sm'
              disabled={busy}
              loading={gen.isPending}
              onClick={() => gen.mutate()}
            >
              {gen.isPending
                ? tVm('vm:codexCredentialPanel.generating')
                : tVm('vm:codexCredentialPanel.generateAuthorizationLink')}
            </Button>
          </div>
        )
      ) : (
        <div className='space-y-2'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <Label htmlFor='codex-import-text'>
              {mode === 'access_token'
                ? tVm('common:accessToken')
                : mode === 'refresh_token'
                  ? tVm('common:refreshToken')
                  : tVm('vm:codexCredentialPanel.accountFile')}
            </Label>
            {mode === 'json' ? (
              <>
                <input
                  ref={fileRef}
                  type='file'
                  accept='application/json,.json'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    void onPickFile(file)
                  }}
                />
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Trans
                    ns='vm'
                    i18nKey='codexCredentialPanel.uploadFile'
                    components={{
                      part0: <Upload className='size-3.5' aria-hidden='true' />,
                    }}
                  />
                </Button>
              </>
            ) : null}
          </div>
          {pickedFile ? (
            <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'>
              <div className='min-w-0'>
                <p className='truncate text-sm'>{pickedFile.name}</p>
                <p className='text-xs text-muted-foreground'>
                  <Trans
                    ns='vm'
                    i18nKey='codexCredentialPanel.loadedOriginalContentHidden'
                    values={{ fileSizeLabel: fileSizeLabel(pickedFile.size) }}
                  />
                </p>
              </div>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => {
                  setPickedFile(null)
                  setText('')
                  setFileError('')
                }}
              >
                <Trans ns='vm' i18nKey='codexCredentialPanel.clear' />
              </Button>
            </div>
          ) : (
            <Textarea
              id='codex-import-text'
              rows={8}
              value={text}
              disabled={busy}
              onChange={(event) => {
                setFileError('')
                setText(event.target.value)
              }}
              placeholder={placeholder}
            />
          )}
          {fileError ? (
            <p className='text-xs text-destructive'>
              {fileError.startsWith('vm:') ? tVm(fileError) : fileError}
            </p>
          ) : null}
          <Hint>
            <Trans
              ns='vm'
              i18nKey='codexCredentialPanel.supportsCodexCLICodexAuthJsonKernelAccountsAnd'
            />
          </Hint>
          <Button
            size='sm'
            disabled={!text.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending
              ? tVm('vm:codexCredentialPanel.writing')
              : tVm('vm:codexCredentialPanel.importGPTOAuth')}
          </Button>
        </div>
      )}
    </div>
  )
}

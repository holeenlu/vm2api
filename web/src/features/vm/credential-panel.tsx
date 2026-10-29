import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AuthScheme, Vm } from '@/types/panel-vm'
import { Copy, ExternalLink } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import {
  authSchemeLabel,
  defaultAuthScheme,
  defaultImportKind,
  defaultImportMethod,
  IMPORT_KINDS,
  importMethodsFor,
  importSurfaceFor,
  importTypeFor,
  oauthFlavorFor,
  resolveImportMethod,
  type ImportKind,
  type ImportMethod,
} from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { loginAuthCode } from '@/lib/login-terminal'
import { proxyNamedLabel } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { type LoginTerminalHandle, WsTerminal } from '@/components/ws-terminal'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CodexCredentialPanel } from '@/features/vm/codex-credential-panel'
import { ConvertOauthToSetupButton } from '@/features/vm/convert-oauth-button'
import { prepareLoginTerminal } from '@/features/vm/login-terminal-start'
import { vmQueryOptions } from '@/features/vm/queries'

export type CommitResult = {
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
  oauth_email?: string
}

const SESSION_KEY_PREFIX = /^sk-ant-sid/i
const CONSOLE_KEY_PREFIX = /^sk-ant-api03-/i

type Link = {
  sessionId: string
  authUrl: string
  expiresAt: number
  proxyHint: string
  /** 生成这条链接时的「类型+方式」签名，用于判断当前面板能否复用它。 */
  sig: string
}

const EMPTY_LINK: Link = {
  sessionId: '',
  authUrl: '',
  expiresAt: 0,
  proxyHint: '',
  sig: '',
}

function useCountdown(expiresAt: number) {
  const { t: tVm } = useTranslation('vm')

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!expiresAt) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  if (!expiresAt) return ''
  const left = Math.floor((expiresAt - now) / 1000)
  if (left <= 0) return tVm('vm:credentialPanel.expired')
  const m = Math.floor(left / 60)
  return `${m}:${String(left % 60).padStart(2, '0')}`
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}) {
  useTranslation('vm')

  return (
    <div
      role='tablist'
      aria-label={label}
      className='flex flex-wrap items-center gap-1.5'
    >
      {options.map((o) => (
        <Button
          key={o.id}
          type='button'
          role='tab'
          size='sm'
          aria-selected={value === o.id}
          disabled={disabled}
          variant={value === o.id ? 'default' : 'outline'}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  useTranslation('vm')

  return <p className='text-xs text-muted-foreground'>{children}</p>
}

export function CredentialPanel({
  vm,
  onCommitted,
  showConvert = true,
  initialKind,
  initialMethod,
  initialCodexMode,
}: {
  vm: Vm
  /** 凭证落盘后回调，交由调用方决定跳转 / 追踪初装。 */
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
  initialKind?: ImportKind
  initialMethod?: ImportMethod
  initialCodexMode?: 'oauth' | 'json'
}) {
  useTranslation('vm')

  if (importSurfaceFor(vm) === 'codex') {
    return (
      <CodexCredentialPanel
        vm={vm}
        onCommitted={onCommitted}
        initialMode={initialCodexMode}
      />
    )
  }
  return (
    <ClaudeCredentialPanel
      key={vm.id}
      vm={vm}
      onCommitted={onCommitted}
      showConvert={showConvert}
      initialKind={initialKind}
      initialMethod={initialMethod}
    />
  )
}

function ClaudeCredentialPanel({
  vm,
  onCommitted,
  showConvert = true,
  initialKind,
  initialMethod,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
  initialKind?: ImportKind
  initialMethod?: ImportMethod
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const vmId = vm.id

  const [kind, setKind] = useState<ImportKind>(
    initialKind || defaultImportKind()
  )
  const [method, setMethod] = useState<ImportMethod>(() =>
    resolveImportMethod(
      initialKind || defaultImportKind(),
      initialMethod || defaultImportMethod(initialKind || defaultImportKind())
    )
  )
  // 跟随**面板选中的凭证类型**，不是槽位当前的类型。
  const [authScheme, setAuthScheme] = useState<AuthScheme>(() =>
    defaultAuthScheme(initialKind || defaultImportKind())
  )
  const [link, setLink] = useState<Link>(EMPTY_LINK)
  const [code, setCode] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginUrl, setLoginUrl] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const loginTerm = useRef<LoginTerminalHandle>(null)
  const activeMethod = resolveImportMethod(kind, method)
  const sig = `${kind}:${activeMethod}`
  const linkReady = !!(link.sessionId && link.authUrl && link.sig === sig)
  const remaining = useCountdown(linkReady ? link.expiresAt : 0)
  const methods = importMethodsFor(kind)

  function switchKind(next: ImportKind) {
    if (next === kind) return
    setKind(next)
    setMethod(defaultImportMethod(next))
    setLink(EMPTY_LINK)
    setCode('')
    setAuthScheme(defaultAuthScheme(next))
  }

  function switchMethod(next: ImportMethod) {
    if (next === method) return
    setMethod(next)
    setLink(EMPTY_LINK)
    setCode('')
  }

  useEffect(() => {
    setLink(EMPTY_LINK)
    setCode('')
  }, [vmId])

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey }),
    ])

  const gen = useMutation({
    mutationFn: (force: boolean) =>
      api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
        reused?: boolean
      }>(`/api/panel/vms/${encodeURIComponent(vmId)}/oauth/generate-auth-url`, {
        method: 'POST',
        body: JSON.stringify({
          // 必须发下划线风格的 setup_token —— 发 claude_setup_token 会被静默
          // 降级成 CAI PKCE 流程且不报错。
          flavor: oauthFlavorFor(kind, activeMethod),
          force,
        }),
      }),
    onSuccess: (d) => {
      setLink({
        sessionId: String(d.session_id || ''),
        authUrl: String(d.auth_url || ''),
        expiresAt: Number(d.expires_at) || 0,
        proxyHint: String(d.proxy_hint || ''),
        sig,
      })
      setCode('')
      toast.success(tVm('vm:codexCredentialPanel.authorizationLinkGenerated'))
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const exchange = useMutation({
    mutationFn: () =>
      api<CommitResult>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/oauth/exchange-code`,
        {
          method: 'POST',
          body: JSON.stringify({
            session_id: link.sessionId,
            code: code.trim(),
            flavor: oauthFlavorFor(kind, activeMethod),
            auth_scheme: authScheme,
          }),
        }
      ),
    onSuccess: async (d) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      onCommitted?.(d, vmId, tVm('vm:credentialPanel.tokenExchangeCompleted'))
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const importCred = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        vm_id: vmId,
        auth_scheme: authScheme,
      }
      if (kind === 'apikey') {
        body.type = 'apikey'
        body.api_key = apiKey.trim()
      } else {
        const type = importTypeFor(kind)
        if (type) {
          body.type = type
          body.scope = 'inference'
        }
        const value = sessionKey.trim()
        // 前缀决定分支：sk-ant-sid 走 cookie 换票，否则按 access token 落盘
        if (SESSION_KEY_PREFIX.test(value)) body.session_key = value
        else body.access_token = value
      }
      return api<CommitResult>('/api/panel/vms/import', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (d) => {
      // 明文凭证提交后立即丢弃，不回显
      setApiKey('')
      setSessionKey('')
      await invalidate()
      onCommitted?.(d, vmId, tVm('vm:credentialPanel.imported'))
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const openLogin = useMutation({
    mutationFn: () => prepareLoginTerminal(vm),
    onSuccess: () => {
      setLoginUrl('')
      setLoginCode('')
      setLoginOpen(true)
      void invalidate()
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  const busy =
    gen.isPending ||
    exchange.isPending ||
    importCred.isPending ||
    openLogin.isPending
  const proxyHint =
    link.proxyHint || (vm.proxy?.host ? proxyNamedLabel(vm.proxy) : '')

  return (
    <div className='space-y-3'>
      <Seg
        label={tVm('vm:credentialPanel.credentialType')}
        value={kind}
        options={IMPORT_KINDS}
        onChange={switchKind}
        disabled={busy}
      />

      {methods.length ? (
        <Seg
          label={tVm('vm:credentialPanel.importMethod')}
          value={activeMethod}
          options={methods}
          onChange={switchMethod}
          disabled={busy}
        />
      ) : null}

      {showConvert ? (
        <ConvertOauthToSetupButton vm={vm} onCommitted={onCommitted} />
      ) : null}

      {kind !== 'oauth' ? (
        <div className='space-y-1'>
          <Label htmlFor='cred-auth-scheme'>
            <Trans
              ns='vm'
              i18nKey='credentialPanel.upstreamAuthenticationHeader'
            />
          </Label>
          <Select
            value={authScheme}
            onValueChange={(v) => setAuthScheme(v as AuthScheme)}
            disabled={busy}
          >
            <SelectTrigger id='cred-auth-scheme' className='w-full sm:w-72'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='x_api_key'>
                {authSchemeLabel('x_api_key')}
              </SelectItem>
              <SelectItem value='authorization_bearer'>
                {authSchemeLabel('authorization_bearer')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Hint>
            <Trans
              ns='vm'
              i18nKey='credentialPanel.claudeConsoleSupportsAuthorizationBearerForSetupTokensYou'
            />
          </Hint>
        </div>
      ) : null}

      {kind === 'apikey' ? (
        <div className='space-y-2'>
          <Label htmlFor='cred-api-key'>Console API Key</Label>
          <Input
            id='cred-api-key'
            type='password'
            autoComplete='off'
            value={apiKey}
            disabled={busy}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder='sk-ant-api03-…'
          />
          <Hint>
            <Trans
              ns='vm'
              i18nKey='credentialPanel.staticKeyFromConsoleAnthropicComClearedFromThe'
            />
          </Hint>
          <Button
            size='sm'
            disabled={!CONSOLE_KEY_PREFIX.test(apiKey.trim()) || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending
              ? tVm('vm:codexCredentialPanel.writing')
              : tVm('vm:credentialPanel.import')}
          </Button>
          {apiKey.trim() && !CONSOLE_KEY_PREFIX.test(apiKey.trim()) ? (
            <Hint>
              <Trans
                ns='vm'
                i18nKey='credentialPanel.aConsoleAPIKeyStartingWithSkAntApi03'
              />
            </Hint>
          ) : null}
        </div>
      ) : activeMethod === 'session' ? (
        <div className='space-y-2'>
          <Label htmlFor='cred-session-key'>sessionKey / access token</Label>
          <Input
            id='cred-session-key'
            type='password'
            autoComplete='off'
            value={sessionKey}
            disabled={busy}
            onChange={(e) => setSessionKey(e.target.value)}
            placeholder={tVm(
              'vm:credentialPanel.skAntSid01OrAccessTokenNeverDisplayedAgain'
            )}
          />
          <Hint>
            {kind === 'setup-token'
              ? !sessionKey.trim()
                ? tVm(
                    'vm:credentialPanel.sessionKeyRequestsFullOAuthScopesProfileInferenceSessionsThrough'
                  )
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? tVm(
                      'vm:credentialPanel.detectedSessionKeyRequestsFullOAuthScopesCollectsIdentityAfter'
                    )
                  : tVm(
                      'vm:credentialPanel.detectedAccessTokenSavesDirectlyAsASetupToken'
                    )
              : !sessionKey.trim()
                ? tVm(
                    'vm:credentialPanel.skAntSidRequestsFullOAuthScopesThroughThe'
                  )
                : SESSION_KEY_PREFIX.test(sessionKey.trim())
                  ? tVm(
                      'vm:credentialPanel.detectedSessionKeyRequestsFullOAuthScopesAndCollectsIdentity'
                    )
                  : tVm(
                      'vm:credentialPanel.detectedAccessTokenSavesDirectlyWithoutAddingPermissions'
                    )}
          </Hint>
          <Button
            size='sm'
            disabled={!sessionKey.trim() || busy}
            loading={importCred.isPending}
            onClick={() => importCred.mutate()}
          >
            {importCred.isPending
              ? tVm('vm:credentialPanel.exchangingToken')
              : tVm('vm:credentialPanel.import')}
          </Button>
        </div>
      ) : activeMethod === 'cc' ? (
        <div className='space-y-2'>
          <Hint>
            {tVm(
              'vm:credentialPanel.openATerminalToStartClaudeTheAuthorizationLink'
            )}
          </Hint>
          <Button
            size='sm'
            disabled={busy}
            loading={openLogin.isPending}
            onClick={() => openLogin.mutate()}
          >
            {openLogin.isPending
              ? tVm('vm:credentialPanel.preparingLoginTerminal')
              : vm.status?.toLowerCase() === 'running'
                ? tVm('vm:credentialPanel.openOfficialLoginTerminal')
                : tVm('vm:credentialPanel.startLoginTerminal')}
          </Button>
          <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
            <DialogContent className='flex h-[min(760px,90vh)] max-w-4xl flex-col gap-3'>
              <DialogHeader>
                <DialogTitle>
                  <Trans ns='vm' i18nKey='credentialPanel.officialLogin' />
                </DialogTitle>
                <DialogDescription>
                  <Trans
                    ns='vm'
                    i18nKey='credentialPanel.pressEnterTwiceInTheTerminalToConfirmThe'
                  />
                </DialogDescription>
              </DialogHeader>
              <div className='space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!loginUrl}
                    onClick={() => {
                      void copyText(loginUrl)
                        .catch(() => false)
                        .then((copied) => {
                          if (copied) {
                            toast.success(
                              tVm(
                                'vm:codexCredentialPanel.authorizationLinkCopied'
                              )
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
                  {loginUrl ? (
                    <a
                      className='inline-flex items-center gap-1 text-xs underline'
                      href={loginUrl}
                      target='_blank'
                      rel='noreferrer'
                    >
                      <Trans
                        ns='vm'
                        i18nKey='codexCredentialPanel.openAuthorizationPage'
                        components={{
                          part0: (
                            <ExternalLink
                              className='size-3'
                              aria-hidden='true'
                            />
                          ),
                        }}
                      />
                    </a>
                  ) : null}
                </div>
                <p className='text-xs break-all text-muted-foreground'>
                  {loginUrl ||
                    tVm(
                      'vm:credentialPanel.waitingForTheAuthorizationLinkInTheTerminal'
                    )}
                </p>
                <div className='space-y-1'>
                  <Label htmlFor='login-auth-code'>
                    <Trans
                      ns='vm'
                      i18nKey='credentialPanel.authorizationCode'
                    />
                  </Label>
                  <Textarea
                    id='login-auth-code'
                    rows={2}
                    value={loginCode}
                    autoComplete='off'
                    spellCheck={false}
                    placeholder={tVm(
                      'vm:credentialPanel.fullAuthorizationCodeIncludingThePartAfter'
                    )}
                    onChange={(event) => setLoginCode(event.target.value)}
                  />
                </div>
                <Button
                  size='sm'
                  disabled={!loginAuthCode(loginCode)}
                  onClick={() => {
                    loginTerm.current?.paste(loginAuthCode(loginCode))
                    setLoginCode('')
                  }}
                >
                  <Trans
                    ns='vm'
                    i18nKey='credentialPanel.enterAuthorizationCode'
                  />
                </Button>
              </div>
              <div className='min-h-0 flex-1'>
                {loginOpen ? (
                  <WsTerminal
                    ref={loginTerm}
                    ticketPath={`/api/panel/vms/${encodeURIComponent(vmId)}/shell-ticket`}
                    socketPath={`/api/panel/vms/${encodeURIComponent(vmId)}/shell`}
                    officialLogin
                    onAuthUrl={setLoginUrl}
                    onLogin={() => {
                      void invalidate()
                      toast.success(
                        tVm(
                          'vm:credentialPanel.officialLoginSavedToSlotCredentials'
                        )
                      )
                    }}
                  />
                ) : null}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : linkReady ? (
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
                  part0: <ExternalLink className='size-3' aria-hidden='true' />,
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
                  ? tVm('vm:codexCredentialPanel.via', { proxyHint: proxyHint })
                  : '',
              }}
            />
          </p>
          <div className='space-y-1'>
            <Label htmlFor='cred-code'>
              <Trans ns='vm' i18nKey='credentialPanel.authorizationCode' />
            </Label>
            <Textarea
              id='cred-code'
              rows={2}
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
              placeholder={tVm(
                'vm:credentialPanel.fullAuthorizationCodeIncludingThePartAfter'
              )}
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
              onClick={() => gen.mutate(true)}
            >
              <Trans ns='vm' i18nKey='codexCredentialPanel.regenerate' />
            </Button>
          </div>
          <Hint>
            {kind === 'setup-token'
              ? tVm(
                  'vm:credentialPanel.requestsFullOAuthScopesAndCollectsIdentityAfterExchange',
                  {
                    value1:
                      proxyHint || tVm('vm:credentialPanel.theSameSlotEgress'),
                  }
                )
              : tVm(
                  'vm:credentialPanel.routeTheBrowserThroughAndIncludeThePartAfter',
                  {
                    value1:
                      proxyHint || tVm('vm:credentialPanel.theSameSlotEgress'),
                  }
                )}
          </Hint>
        </div>
      ) : (
        <div className='space-y-2'>
          <Hint>
            {kind === 'setup-token'
              ? tVm(
                  'vm:credentialPanel.generatesAnAuthorizationLinkForFullOAuthScopesToken',
                  {
                    value1:
                      proxyHint || tVm('vm:credentialPanel.theSameSlotEgress'),
                  }
                )
              : tVm(
                  'vm:credentialPanel.tokenExchangeUsesTheSlotSOCKS5RouteTheBrowser',
                  {
                    value1:
                      proxyHint || tVm('vm:credentialPanel.theSameSOCKS5Proxy'),
                  }
                )}
          </Hint>
          <Button
            size='sm'
            disabled={busy}
            loading={gen.isPending}
            onClick={() => gen.mutate(false)}
          >
            {gen.isPending
              ? tVm('vm:codexCredentialPanel.generating')
              : tVm('vm:codexCredentialPanel.generateAuthorizationLink')}
          </Button>
        </div>
      )}
    </div>
  )
}

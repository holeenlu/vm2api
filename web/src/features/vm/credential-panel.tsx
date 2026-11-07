import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AuthScheme, Vm } from '@/types/panel-vm'
import {
  Copy,
  ExternalLink,
  Keyboard,
  Link2,
  SquareTerminal,
} from 'lucide-react'
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
  prepareVm,
  draftId,
  prepareDraft,
  initialCodexMode,
  gatewayAccount = false,
}: {
  vm: Vm
  /** 凭证落盘后回调，交由调用方决定跳转 / 追踪初装。 */
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
  initialKind?: ImportKind
  initialMethod?: ImportMethod
  prepareVm?: (authorizationKind: string) => Promise<Vm>
  draftId?: string
  prepareDraft?: (authorizationKind: string) => Promise<string>
  initialCodexMode?: 'oauth' | 'json'
  /** Codex 账号由 Gateway Worker 执行（凭据存于 Worker），授权说明不再提槽位。 */
  gatewayAccount?: boolean
}) {
  useTranslation('vm')

  if (importSurfaceFor(vm) === 'codex') {
    return (
      <CodexCredentialPanel
        vm={vm}
        onCommitted={onCommitted}
        initialMode={initialCodexMode}
        prepareVm={prepareVm}
        draftId={draftId}
        prepareDraft={prepareDraft}
        gatewayAccount={gatewayAccount}
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
      prepareVm={prepareVm}
      draftId={draftId}
      prepareDraft={prepareDraft}
    />
  )
}

function ClaudeCredentialPanel({
  vm,
  onCommitted,
  showConvert = true,
  initialKind,
  initialMethod,
  prepareVm,
  draftId,
  prepareDraft,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
  showConvert?: boolean
  initialKind?: ImportKind
  initialMethod?: ImportMethod
  prepareVm?: (authorizationKind: string) => Promise<Vm>
  draftId?: string
  prepareDraft?: (authorizationKind: string) => Promise<string>
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const prepared = useRef<Vm | null>(null)
  const preparedDraft = useRef('')
  const [preparedVm, setPreparedVm] = useState<Vm | null>(null)
  const vmId = vm.id || preparedVm?.id || ''
  const currentVmId = () => vm.id || prepared.current?.id || ''
  const currentDraftId = () => draftId || preparedDraft.current

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

  async function runtimeId() {
    if (currentVmId()) return currentVmId()
    if (currentDraftId()) return ''
    if (prepareDraft) {
      preparedDraft.current = await prepareDraft(
        kind === 'apikey'
          ? 'claude_console'
          : kind === 'setup-token'
            ? 'claude_setup_token'
            : 'claude_oauth'
      )
      return ''
    }
    if (!prepareVm)
      throw new Error(tVm('vm:credentialPanel.accountNotPrepared'))
    const ready = await prepareVm(
      kind === 'apikey'
        ? 'claude_console'
        : kind === 'setup-token'
          ? 'claude_setup_token'
          : 'claude_oauth'
    )
    prepared.current = ready
    setPreparedVm(ready)
    return ready.id
  }

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
  }, [vm.id, draftId])

  function authBase() {
    const draft = currentDraftId()
    return draft
      ? `/api/vendor/account-drafts/${encodeURIComponent(draft)}`
      : `/api/panel/vms/${encodeURIComponent(currentVmId())}`
  }

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({
        queryKey: vmQueryOptions(currentVmId()).queryKey,
      }),
    ])

  const gen = useMutation({
    mutationFn: async (force: boolean) => {
      await runtimeId()
      return api<{
        auth_url?: string
        session_id?: string
        expires_at?: number
        proxy_hint?: string | null
        reused?: boolean
      }>(`${authBase()}/oauth/generate-auth-url`, {
        method: 'POST',
        body: JSON.stringify({
          // 必须发下划线风格的 setup_token —— 发 claude_setup_token 会被静默
          // 降级成 CAI PKCE 流程且不报错。
          flavor: oauthFlavorFor(kind, activeMethod),
          force,
        }),
      })
    },
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
    mutationFn: async () => {
      await runtimeId()
      return api<CommitResult>(`${authBase()}/oauth/exchange-code`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: link.sessionId,
          code: code.trim(),
          flavor: oauthFlavorFor(kind, activeMethod),
          auth_scheme: authScheme,
        }),
      })
    },
    onSuccess: async (d) => {
      setCode('')
      setLink(EMPTY_LINK)
      await invalidate()
      onCommitted?.(
        d,
        currentVmId(),
        tVm('vm:credentialPanel.tokenExchangeCompleted')
      )
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const importCred = useMutation({
    mutationFn: async () => {
      const target = await runtimeId()
      const body: Record<string, unknown> = { auth_scheme: authScheme }
      if (currentDraftId()) body.draft_id = currentDraftId()
      else body.vm_id = target
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
      return api<CommitResult>(
        currentDraftId()
          ? `/api/vendor/account-drafts/${encodeURIComponent(currentDraftId())}/import`
          : '/api/panel/vms/import',
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      )
    },
    onSuccess: async (d) => {
      // 明文凭证提交后立即丢弃，不回显
      setApiKey('')
      setSessionKey('')
      await invalidate()
      onCommitted?.(d, currentVmId(), tVm('vm:credentialPanel.imported'))
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  const openLogin = useMutation({
    mutationFn: async () => {
      if (prepareDraft)
        throw new Error(
          '供应商开户授权前不能使用 Claude Code 官方终端，请改用 OAuth 或 Setup Token'
        )
      await runtimeId()
      return prepareLoginTerminal(vm.id ? vm : prepared.current!)
    },
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
            <DialogContent className='flex h-[min(820px,calc(100svh-1.5rem))] w-[min(1120px,calc(100vw-1.5rem))] max-w-none flex-col gap-0 overflow-hidden border-border/70 bg-background p-0'>
              <div className='shrink-0 border-b bg-muted/15 px-5 py-4'>
                <DialogHeader className='gap-1'>
                  <div className='flex items-center gap-2.5'>
                    <span className='grid size-8 place-items-center rounded-md bg-foreground text-background'>
                      <SquareTerminal className='size-4' aria-hidden='true' />
                    </span>
                    <div className='min-w-0'>
                      <DialogTitle className='text-base'>
                        {tVm('vm:credentialPanel.claudeCodeLogin')}
                      </DialogTitle>
                      <DialogDescription className='mt-1 text-xs'>
                        {tVm('vm:credentialPanel.claudeCodeLoginDescription')}
                      </DialogDescription>
                    </div>
                    <span className='ml-auto hidden items-center gap-1 rounded-full border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground sm:inline-flex'>
                      <span className='size-1.5 rounded-full bg-zinc-400' />
                      {/* i18n-exempt "PTY / TUI" -- Terminal transport protocol names, identical in every locale. */}
                      PTY / TUI
                    </span>
                  </div>
                </DialogHeader>
              </div>

              <div className='grid min-h-0 flex-1 grid-rows-[minmax(340px,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1'>
                <section className='flex min-h-0 flex-col bg-[#080a0d] p-3 sm:p-4'>
                  <div className='mb-2 flex shrink-0 items-center justify-between gap-3 px-1 text-[11px] text-zinc-400'>
                    <div className='flex min-w-0 items-center gap-2'>
                      <span className='font-mono text-zinc-200'>
                        {/* i18n-exempt "claude auth login" -- CLI command shown verbatim. */}
                        claude auth login
                      </span>
                      <span className='truncate text-zinc-600'>
                        {/* i18n-exempt "/home/kincli" -- Filesystem path inside the slot, shown verbatim. */}
                        /home/kincli
                      </span>
                    </div>
                    <button
                      type='button'
                      className='inline-flex shrink-0 items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none'
                      onClick={() => loginTerm.current?.focus()}
                    >
                      <Keyboard className='size-3' aria-hidden='true' />
                      {tVm('vm:credentialPanel.focusTerminal')}
                    </button>
                  </div>
                  <div className='min-h-0 flex-1 rounded-lg border border-zinc-800 bg-[#0b0d10] p-1 shadow-[0_16px_50px_rgba(0,0,0,0.28)]'>
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
                  <p className='mt-2 shrink-0 px-1 text-[11px] leading-relaxed text-zinc-500'>
                    <Trans
                      ns='vm'
                      i18nKey='credentialPanel.terminalPasteHint'
                      components={{
                        code: <code className='text-zinc-300' />,
                      }}
                    />
                  </p>
                </section>

                <aside className='min-h-0 overflow-y-auto border-t bg-muted/20 p-4 lg:border-t-0 lg:border-l'>
                  <div className='space-y-4'>
                    <div>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background'>
                          1
                        </span>
                        <div>
                          <p className='text-sm font-medium'>
                            {tVm('vm:credentialPanel.copyAuthorizationLink')}
                          </p>
                          <p className='text-[11px] text-muted-foreground'>
                            {tVm(
                              'vm:credentialPanel.finishClaudeLoginInBrowser'
                            )}
                          </p>
                        </div>
                      </div>
                      <div className='flex gap-2'>
                        <Input
                          aria-label={tVm(
                            'vm:credentialPanel.claudeCodeAuthorizationLink'
                          )}
                          readOnly
                          value={loginUrl}
                          placeholder={tVm(
                            'vm:credentialPanel.waitingForTerminalLink'
                          )}
                          className='h-9 min-w-0 bg-background font-mono text-[11px]'
                        />
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          className='h-9 shrink-0 gap-1.5 px-2.5'
                          aria-label={tVm(
                            'vm:credentialPanel.copyAuthorizationLink'
                          )}
                          disabled={!loginUrl}
                          onClick={async () => {
                            try {
                              if (!(await copyText(loginUrl))) {
                                throw new Error('copy failed')
                              }
                              toast.success(
                                tVm(
                                  'vm:codexCredentialPanel.authorizationLinkCopied'
                                )
                              )
                            } catch {
                              toast.error(
                                tVm(
                                  'vm:codexCredentialPanel.copyFailedSelectTheLinkManually'
                                )
                              )
                            }
                          }}
                        >
                          <Copy className='size-3.5' aria-hidden='true' />
                          <span className='sr-only sm:not-sr-only'>
                            {tVm('vm:credentialPanel.copyLinkText')}
                          </span>
                        </Button>
                      </div>
                      {loginUrl ? (
                        <a
                          className='mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground'
                          href={loginUrl}
                          target='_blank'
                          rel='noreferrer'
                        >
                          <Link2 className='size-3' aria-hidden='true' />
                          {tVm('vm:credentialPanel.openInNewTab')}
                          <ExternalLink className='size-3' aria-hidden='true' />
                        </a>
                      ) : null}
                    </div>

                    <div className='border-t pt-4'>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background'>
                          2
                        </span>
                        <div>
                          <p className='text-sm font-medium'>
                            {tVm('vm:credentialPanel.fillCallbackCode')}
                          </p>
                          <p className='text-[11px] text-muted-foreground'>
                            {tVm(
                              'vm:credentialPanel.callbackCodeMustIncludeState'
                            )}
                          </p>
                        </div>
                      </div>
                      <Textarea
                        id='login-auth-code'
                        rows={4}
                        value={loginCode}
                        autoComplete='off'
                        spellCheck={false}
                        placeholder={tVm(
                          'vm:credentialPanel.pasteFullCodeState'
                        )}
                        className='resize-none bg-background font-mono text-xs leading-relaxed'
                        onChange={(event) => setLoginCode(event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key === 'Enter'
                          ) {
                            event.preventDefault()
                            const value = loginAuthCode(loginCode)
                            if (value) {
                              loginTerm.current?.paste(value)
                              setLoginCode('')
                            }
                          }
                        }}
                      />
                      <Button
                        type='button'
                        size='sm'
                        className='mt-2 w-full'
                        disabled={!loginAuthCode(loginCode)}
                        onClick={() => {
                          loginTerm.current?.paste(loginAuthCode(loginCode))
                          setLoginCode('')
                        }}
                      >
                        {tVm('vm:credentialPanel.fillIntoTerminal')}
                      </Button>
                      <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
                        {tVm('vm:credentialPanel.fillIntoTerminalHint')}
                      </p>
                    </div>

                    <div className='rounded-md border border-dashed bg-background/70 p-3 text-[11px] leading-relaxed text-muted-foreground'>
                      <div className='mb-1 flex items-center gap-1.5 text-foreground'>
                        <Keyboard className='size-3.5' aria-hidden='true' />
                        {tVm('vm:credentialPanel.terminalShortcuts')}
                      </div>
                      <p>{tVm('vm:credentialPanel.terminalShortcutsHint')}</p>
                    </div>
                  </div>
                </aside>
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
          {/* 只占一行省略显示；完整链接仍在 DOM 中，复制失败时可单击全选手动复制 */}
          <p className='line-clamp-1 text-xs break-all text-muted-foreground select-all'>
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

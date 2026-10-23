import { t } from '@/i18n'
import { isApiError } from '@/lib/api'

/**
 * 错误码 → 补充引导。只收录那些 gateway 原文不足以指导下一步的码。
 *
 * ⚠️ 故意**不收** `credential_mode_unsupported`：它是跨语义复用码，
 * 在「手动初装 400」「刷新凭证 400」下含义完全不同
 * （`官方初装只支持完整 OAuth` vs `Console API Key 不能刷新`），
 * 套一句固定文案必然在其中一处说错。这个码一律透传 gateway 的 message，
 * 并在 UI 上按来源提前禁用按钮，让用户根本触发不到。
 */
const HINTS: Record<string, string> = {
  session_stale_relogin: 'lib:importErrors.sessionStaleRelogin',
  cloudflare_challenge: 'lib:importErrors.cloudflareChallenge',
  import_failed: 'lib:importErrors.importFailed',
  proxy_required: 'lib:importErrors.proxyRequired',
  session_expired: 'lib:importErrors.sessionExpired',
  session_vm_mismatch: 'lib:importErrors.sessionVmMismatch',
  code_required: 'lib:importErrors.codeRequired',
  // 槽内 CLI 喂码超时。gateway 明确要求「不要重新生成」，
  // 而是再打开当前链接取新授权码 —— 别把用户引到「重新生成」按钮上。
  setup_token_timeout: 'lib:importErrors.setupTokenTimeout',
  setup_token_invalid_code: 'lib:importErrors.setupTokenInvalidCode',
  cli_node_missing: 'lib:importErrors.cliNodeMissing',
  setup_token_url_timeout: 'lib:importErrors.setupTokenUrlTimeout',
  bridge_failed: 'lib:importErrors.bridgeFailed',
  worker_credential_import_failed:
    'lib:importErrors.workerCredentialImportFailed',
  placement_forbidden: 'lib:importErrors.placementForbidden',
  node_not_found: 'lib:importErrors.nodeNotFound',
  placement_preflight_failed: 'lib:importErrors.placementPreflightFailed',
  remote_unsupported: 'lib:importErrors.remoteUnsupported',
  kvm_unavailable: 'lib:importErrors.kvmUnavailable',
}

export function importErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = isApiError(error) ? error.code : ''
  const hintKey =
    code && Object.prototype.hasOwnProperty.call(HINTS, code) ? HINTS[code] : ''
  const hint = hintKey ? t(hintKey) : ''
  if (!hint) return raw
  return raw ? t('lib:importErrors.withDetail', { hint, message: raw }) : hint
}

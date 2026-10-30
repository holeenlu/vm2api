import { t as translate } from '@/i18n'
import type { ClusterApiNode, ClusterNodePatch } from '@/types/panel-cluster'

export type NodeConnectionDraft = {
  host: string
  port: string
  username: string
  authType: 'key' | 'password'
  replaceCredentials: boolean
  privateKey: string
  passphrase: string
  password: string
}

export function connectionDraft(node: ClusterApiNode): NodeConnectionDraft {
  return {
    host: node.host,
    port: String(node.port),
    username: node.username,
    authType: node.auth_type,
    replaceCredentials: false,
    privateKey: '',
    passphrase: '',
    password: '',
  }
}

export function renameNodePatch(
  node: ClusterApiNode,
  label: string
): ClusterNodePatch {
  const value = label.trim()
  if (!value || value.length > 64)
    throw new Error(translate('cluster:error.nameLength'))
  if (value === node.label)
    throw new Error(translate('cluster:error.nameUnchanged'))
  return { expected_updated_at: node.updated_at, label: value }
}

export function connectionNodePatch(
  node: ClusterApiNode,
  draft: NodeConnectionDraft,
  {
    vmCount,
    dependentCount,
  }: { vmCount: number | null; dependentCount: number }
): ClusterNodePatch {
  if (dependentCount > 0) throw new Error(translate('cluster:error.dependents'))
  const host = draft.host.trim()
  const username = draft.username.trim()
  const port = Number(draft.port)
  if (!host) throw new Error(translate('cluster:error.hostRequired'))
  if (
    !/^\d+$/.test(draft.port) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(translate('cluster:error.portRange'))
  }
  if (!username) throw new Error(translate('cluster:error.usernameRequired'))
  const patch: ClusterNodePatch = { expected_updated_at: node.updated_at }
  if (host !== node.host) patch.host = host
  if (port !== node.port) patch.port = port
  if (username !== node.username) {
    if (vmCount !== 0) throw new Error(translate('cluster:error.usernameSlots'))
    patch.username = username
  }
  const authChanged = draft.authType !== node.auth_type
  if (authChanged) patch.auth_type = draft.authType
  if (authChanged || draft.replaceCredentials) {
    if (draft.authType === 'key') {
      if (!draft.privateKey.trim())
        throw new Error(translate('cluster:error.newKeyRequired'))
      patch.private_key = draft.privateKey.trim()
      // Empty means this replacement key has no passphrase, not "keep the old one".
      patch.passphrase = draft.passphrase
    } else {
      if (!draft.password)
        throw new Error(translate('cluster:error.newPasswordRequired'))
      patch.password = draft.password
    }
  }
  if (Object.keys(patch).length === 1)
    throw new Error(translate('cluster:error.connectionUnchanged'))
  return patch
}

/** A field edit, cancellation or unmount invalidates every older async result. */
export class NodeEditRequests {
  private revision = 0
  private controller: AbortController | null = null

  cancel() {
    this.revision++
    this.controller?.abort()
    this.controller = null
  }

  begin() {
    this.cancel()
    this.controller = new AbortController()
    return { revision: this.revision, signal: this.controller.signal }
  }

  accepts(request: { revision: number; signal: AbortSignal }) {
    return (
      request.revision === this.revision &&
      request.signal === this.controller?.signal &&
      !request.signal.aborted
    )
  }
}

export function nodeEditError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (code === 'node_edit_conflict') return translate('cluster:error.conflict')
  if (code === 'node_not_found') return translate('cluster:error.removed')
  if (code === 'node_username_in_use')
    return translate('cluster:error.usernameInUse')
  if (code === 'node_in_use')
    return error instanceof Error
      ? error.message
      : translate('cluster:error.inUse')
  if (code === 'host_key_mismatch')
    return translate('cluster:error.fingerprintMismatch')
  return error instanceof Error
    ? error.message
    : translate('cluster:error.requestFailed')
}

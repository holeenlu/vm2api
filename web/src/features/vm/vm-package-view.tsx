import { t as tVm } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { localProxyText } from '@/lib/vm-status'
import { localizedOption } from './localized-option'

export type PackageFacts = {
  ok: true
  id: string
  name: string
  platform: string
  kernel: string
  timezone: string
  proxy: string
  credential: string
}

export type PackageRead =
  { ok: false; error: string } | ({ ok: true } & PackageFacts)

function textOf(value: unknown, max = 80) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function readPackageFacts(text: string): PackageRead | null {
  const raw = text.trim()
  if (!raw) return null
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      error: tVm('vm:vmPackageView.jSONIsNotACompletePackageYet'),
    }
  }
  const root = record(doc)
  if (!root || root.type !== 'tapmodels-vm-package') {
    return {
      ok: false,
      error: tVm('vm:vmPackageView.notATapmodelsSingleSlotPackage'),
    }
  }
  const vm = record(root.vm)
  if (!vm)
    return { ok: false, error: tVm('vm:vmPackageView.packageHasNoVmEntry') }
  const proxy = record(root.proxy)
  const credential = record(root.credential)
  const kind = textOf(proxy?.kind || proxy?.scheme).toLowerCase()
  let proxyText = tVm('vm:vmPackageView.noProxyIncluded')
  if (proxy) {
    proxyText =
      kind === 'local' || proxy.host === 'local'
        ? tVm('vm:vmPackageView.localProxy', { value1: localProxyText() })
        : [textOf(proxy.host), proxy.port].filter(Boolean).join(':') || 'SOCKS5'
  }
  let credentialText = tVm('vm:detailStatusBoard.noCredentials')
  if (credential) {
    const platform = textOf(credential.platform).toLowerCase()
    credentialText =
      platform === 'openai'
        ? tVm('vm:vmPackageView.codexCredentials')
        : tVm('vm:vmPackageView.claudeCredentials')
  }
  const platform = textOf(vm.platform || vm.family) || '—'
  return {
    ok: true,
    id: textOf(vm.id) || '—',
    name: textOf(vm.name) || '—',
    platform,
    kernel: textOf(vm.kernel) || '—',
    timezone: textOf(vm.timezone) || '—',
    proxy: proxyText,
    credential: credentialText,
  }
}

const FACTS = [
  localizedOption('id', 'vm:testChatTypes.slot'),
  localizedOption('name', 'vm:createVmForm.name'),
  localizedOption('platform', 'vm:createVmForm.platform'),
  localizedOption('kernel', 'vm:createVmForm.operatingSystem'),
  localizedOption('timezone', 'vm:physicalFeaturesCard.timezone'),
  localizedOption('proxy', 'vm:createExitField.egress'),
  localizedOption('credential', 'vm:detailTestTab.credentials'),
] as const

export function PackageFacts({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  useTranslation('vm')

  const facts = readPackageFacts(text)
  if (!facts) return null
  if (!facts.ok) {
    return <p className='text-xs text-destructive'>{facts.error}</p>
  }
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4',
        className
      )}
    >
      {FACTS.map(([key, label]) => (
        <div key={key} className='min-w-0'>
          <dt className='text-[11px] text-muted-foreground'>{label}</dt>
          <dd className='truncate font-mono text-xs text-foreground'>
            {facts[key]}
          </dd>
        </div>
      ))}
    </dl>
  )
}

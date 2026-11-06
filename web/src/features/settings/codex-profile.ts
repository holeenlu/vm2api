import type { ClientProfileSelection } from '@/types/panel-keys'

export const DEFAULT_CLIENT_PROFILE: ClientProfileSelection = {
  client: 'desktop',
  platform: 'macos',
  versionMode: 'latest',
}

// 只保留当前模式会用到的字段，避免把切换前的值一起保存
export function cleanProfile(
  value: ClientProfileSelection
): ClientProfileSelection {
  if (value.mode === 'custom') {
    return {
      mode: 'custom',
      userAgent: value.userAgent || '',
      ...(value.originator ? { originator: value.originator } : {}),
      ...(value.codexVersion ? { codexVersion: value.codexVersion } : {}),
    }
  }
  const out: ClientProfileSelection = {
    client: value.client || 'desktop',
    platform: value.platform || 'macos',
    versionMode: value.versionMode || 'latest',
  }
  if (out.client === 'cli' && value.cliEntry) out.cliEntry = value.cliEntry
  if (out.versionMode === 'latest') {
    if (value.versionLag) out.versionLag = value.versionLag
  } else {
    out.codexVersion = value.codexVersion || ''
    if (out.client === 'desktop') {
      out.desktopVersion = value.desktopVersion || ''
      out.desktopBuild = value.desktopBuild || ''
    }
  }
  return out
}

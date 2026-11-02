import { i18n } from '@/i18n'
import type { ClusterApiNode } from '@/types/panel-cluster'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { buildLocalNode, LINK_STATE_TEXT, LINK_TONE } from './model'
import {
  connectionDraft,
  connectionNodePatch,
  nodeEditError,
  renameNodePatch,
} from './node-edit'

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
describe('cluster language changes', () => {
  it('refreshes exported status labels while keeping status keys and topology invariant', async () => {
    const cases = [
      ['en-US', 'Connected', 'Local'],
      ['zh-CN', '已连接', '本机'],
      ['zh-TW', '已連線', '本機'],
      ['ja-JP', '接続済み', 'ローカル'],
    ] as const
    for (const [locale, connected, local] of cases) {
      await i18n.changeLanguage(locale)
      expect(LINK_STATE_TEXT.ready).toBe(connected)
      expect(LINK_TONE.ok).toMatchObject({
        key: 'ok',
        cls: 'ok',
        text: connected,
      })
      expect(
        buildLocalNode({
          host: 'node.example',
          vms: [],
          spendUsd: 0,
          available: true,
        })
      ).toMatchObject({
        id: 'local',
        label: local,
        host: 'node.example',
        link: 'ok',
        vmCount: 0,
      })
    }
  })
  it('keeps draft values, host credentials and optimistic-lock payloads unchanged across languages', async () => {
    const node: ClusterApiNode = {
      id: 'n1',
      label: '東京 原文',
      host: 'host.example',
      port: 22,
      username: 'user',
      auth_type: 'key',
      updated_at: '2026-10-21T00:00:00Z',
      host_key_alg: 'ssh-ed25519',
      host_key_sha256: 'SHA256:test',
      jump_node_id: null,
      created_at: '2026-10-20T00:00:00Z',
      link: { state: 'ready' },
      health: null,
      bridge: null,
      install: null,
    }
    const draft = {
      ...connectionDraft(node),
      host: 'new.example',
      replaceCredentials: true,
      privateKey: 'PRIVATE 原文',
      passphrase: 'keep 原文',
    }
    const initial = structuredClone(draft)
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      await i18n.changeLanguage(locale)
      expect(
        connectionNodePatch(node, draft, { vmCount: 0, dependentCount: 0 })
      ).toEqual({
        expected_updated_at: '2026-10-21T00:00:00Z',
        host: 'new.example',
        private_key: 'PRIVATE 原文',
        passphrase: 'keep 原文',
      })
      expect(renameNodePatch(node, '  Name 原文  ')).toEqual({
        expected_updated_at: '2026-10-21T00:00:00Z',
        label: 'Name 原文',
      })
      expect(draft).toEqual(initial)
    }
  })
  it('renders a retained API error in the current language and preserves unknown error details', async () => {
    const error = new ApiError(
      'original server text',
      409,
      'node_edit_conflict'
    )
    await i18n.changeLanguage('en-US')
    expect(nodeEditError(error)).toContain('Cancel and reopen')
    await i18n.changeLanguage('ja-JP')
    expect(nodeEditError(error)).toContain('キャンセル')
    expect(nodeEditError(new Error('opaque server log 原文'))).toBe(
      'opaque server log 原文'
    )
  })
  it('preserves raw multiline installation logs after the localized status', async () => {
    const log = ['raw model-id 原文', '{{name}} $t(untrusted)', 'exit=1'].join(
      String.fromCharCode(10)
    )
    for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
      await i18n.changeLanguage(locale)
      const status = i18n.t('cluster:docker.installDone')
      expect(
        i18n.t('cluster:docker.hostInfo', { value1: status, value2: log })
      ).toBe(status + String.fromCharCode(10) + log)
    }
  })
})

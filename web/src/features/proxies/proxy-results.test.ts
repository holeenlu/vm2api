import { i18n } from '@/i18n'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  bindOutcome,
  deleteConfirmText,
  disableConfirmText,
  editOutcome,
  probeAllOutcome,
  probeOneOutcome,
} from './proxy-results'

describe('proxy action outcomes', () => {
  it('reports failed connections even when the probe request returned HTTP 200', () => {
    expect(
      probeOneOutcome({ probe: { ok: false, error: 'ECONNREFUSED' } })
    ).toEqual({ level: 'error', text: '连接失败：ECONNREFUSED' })
    expect(
      probeOneOutcome({ probe: { ok: true, scope: 'socks', latency_ms: 0 } })
        .text
    ).toContain('0 ms')
    expect(
      probeOneOutcome({ probe: { ok: false, scope: 'pending' } }).level
    ).toBe('info')
    expect(
      probeOneOutcome({ probe: { ok: true, scope: 'local' } }).text
    ).toContain('质量检测')
  })
  it('warns when the slot reload after binding failed', () => {
    const out = bindOutcome('vm-1 已绑定', { ok: false, error: 'boot timeout' })
    expect(out.level).toBe('warning')
    expect(out.text).toContain('boot timeout')
    expect(out.text).toContain('停止调度')
    expect(bindOutcome('vm-1 已绑定', null).level).toBe('success')
    expect(bindOutcome('vm-1 已绑定', { ok: true }).level).toBe('success')
  })

  it('reports a failed egress restart after editing a proxy', () => {
    const out = editOutcome({
      workers: [],
      egress: { ok: false, error: 'egress_restart_failed' },
    })
    expect(out.level).toBe('warning')
    expect(out.text).toContain('出口转发重启失败')
    expect(editOutcome({ workers: [], egress: null }).level).toBe('success')
  })

  it('lists failed slot reloads after editing a proxy', () => {
    const out = editOutcome({
      workers: [
        { vm_id: 'vm-1', ok: false },
        { vm_id: 'vm-2', ok: true },
      ],
    })
    expect(out.text).toContain('1 台槽位重载失败：vm-1')
  })

  it('does not call an in-progress probe finished', () => {
    const busy = probeAllOutcome({ ok: false, error: 'probe_in_progress' })
    expect(busy.level).toBe('info')
    expect(busy.text).not.toContain('完成')
    const done = probeAllOutcome({
      ok: true,
      total: 2,
      results: [{ ok: true }, { ok: false }],
    })
    expect(done).toEqual({ level: 'success', text: '代理探测完成 1/2' })
  })

  it('spells out that bound slots stop scheduling', () => {
    expect(disableConfirmText(3)).toContain('3 台槽位会全部停止调度')
    expect(deleteConfirmText(2)).toContain('2 台槽位会解绑并停止调度')
  })
})

const initialLanguage = i18n.language
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})
afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
})

it('interpolates complete failure sentences and locale-specific lists without changing outcomes', async () => {
  const reason = 'raw <boot timeout> 原始诊断'
  for (const language of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP']) {
    await i18n.changeLanguage(language)
    const failed = bindOutcome('vm-1', { ok: false, error: reason })
    expect(failed.level).toBe('warning')
    expect(failed.text).toBe(
      i18n.t('proxies:bindReloadFailedReason', { done: 'vm-1', reason })
    )
    expect(failed.text).toContain(reason)
    expect(bindOutcome('vm-1', { ok: false }).text).toBe(
      i18n.t('proxies:bindReloadFailed', { done: 'vm-1' })
    )
    const edited = editOutcome({
      workers: [
        { vm_id: 'vm-1', ok: false },
        { vm_id: 'vm-2', ok: false },
      ],
      egress: { ok: false, error: reason },
    })
    expect(edited.level).toBe('warning')
    expect(edited.text).toContain(
      language === 'en-US' ? 'vm-1, vm-2' : 'vm-1、vm-2'
    )
    expect(edited.text).toContain(reason)
    expect(edited.text).not.toContain('{{')
    expect(editOutcome({ workers: [{ vm_id: 'vm-1', ok: true }] }).level).toBe(
      'success'
    )
  }
})

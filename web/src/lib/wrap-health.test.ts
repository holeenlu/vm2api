import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  kernelHopReady,
  kernelProcessUp,
  wrapHealthLabel,
  wrapSyncKernelFails,
} from './wrap-health'

// Keep the existing Chinese UI assertions independent of the host locale.
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('wrapHealthLabel', () => {
  it('shows cli-hop ready slots from worker_version not version', () => {
    expect(
      wrapHealthLabel({
        reachable: true,
        process_up: true,
        provider: 'local_cli',
        ready_slots: 20,
        worker_version: 'wrap-1',
      })
    ).toBe('在线 · cli-hop · 20 槽就绪 · wrap-1')
  })

  it('distinguishes kernel-up from CLI not ready', () => {
    expect(
      wrapHealthLabel({
        reachable: false,
        process_up: true,
        ready_slots: 0,
      })
    ).toBe('kernel 在 · CLI 未就绪 · 槽 0')
  })
})

describe('kernel hop vs process', () => {
  it('treats ready_slots=0 as process up, hop not ready', () => {
    const health = { reachable: false, process_up: true, ready_slots: 0 }
    expect(kernelProcessUp(health)).toBe(true)
    expect(kernelHopReady(health)).toBe(false)
  })
})

describe('wrapSyncKernelFails', () => {
  it('counts file-ok items whose kernel bounce failed', () => {
    expect(
      wrapSyncKernelFails([
        { ok: true, kernel: { ok: true } },
        { ok: true, kernel: { ok: false } },
        { ok: false },
      ])
    ).toBe(1)
  })
})

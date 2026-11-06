import { describe, expect, it, vi } from 'vitest'
import {
  STALE_ASSET_RELOAD_WINDOW_MS,
  installStaleAssetReload,
  reloadForStaleAssets,
} from './stale-asset-reload'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

describe('stale asset reload', () => {
  it('reloads once and not again within the window', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    let clock = 1_000_000
    const now = () => clock
    expect(reloadForStaleAssets({ storage, now, reload })).toBe(true)
    expect(reloadForStaleAssets({ storage, now, reload })).toBe(false)
    clock += STALE_ASSET_RELOAD_WINDOW_MS
    expect(reloadForStaleAssets({ storage, now, reload })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('prevents the default error only when it reloads', () => {
    const listeners: Array<(event: Event) => void> = []
    const target = {
      addEventListener: (_type: string, listener: (event: Event) => void) =>
        void listeners.push(listener),
    }
    const storage = memoryStorage()
    const reload = vi.fn()
    installStaleAssetReload(target as unknown as Window, {
      storage,
      now: () => 5_000_000,
      reload,
    })
    const first = { preventDefault: vi.fn() } as unknown as Event
    listeners[0](first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    const second = { preventDefault: vi.fn() } as unknown as Event
    listeners[0](second)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

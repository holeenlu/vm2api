/**
 * 发布新版本后，已打开的页面还引用旧的分块文件名；旧文件已删除，懒加载路由时取到 404，
 * 路由出错页显示 500。Vite 在动态导入或预加载失败时派发 `vite:preloadError`：
 * 这里重新加载页面以取得新版本的入口。30 秒内只重载一次，避免资源真的缺失时循环刷新
 * （那种情况仍显示出错页）。
 */
const RELOAD_KEY = 'kin:stale-asset-reload-at'
export const STALE_ASSET_RELOAD_WINDOW_MS = 30_000

type ReloadDeps = {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  now?: () => number
  reload?: () => void
}

/** 需要时重载页面；返回是否已发起重载。 */
export function reloadForStaleAssets({
  storage = safeSessionStorage(),
  now = Date.now,
  reload = () => window.location.reload(),
}: ReloadDeps = {}): boolean {
  const at = now()
  const last = Number(storage?.getItem(RELOAD_KEY) || 0)
  if (last && at - last < STALE_ASSET_RELOAD_WINDOW_MS) return false
  try {
    storage?.setItem(RELOAD_KEY, String(at))
  } catch {
    // 存储不可用时仍重载一次；拿不到上次时间就无法限频，但不会比不处理更糟
  }
  reload()
  return true
}

export function installStaleAssetReload(
  target: Pick<Window, 'addEventListener'> = window,
  deps: ReloadDeps = {}
) {
  target.addEventListener('vite:preloadError', (event) => {
    // 已发起重载时阻止 Vite 继续抛错；未重载时让错误照常交给路由出错页
    if (reloadForStaleAssets(deps)) event.preventDefault()
  })
}

function safeSessionStorage() {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

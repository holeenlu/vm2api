/**
 * 面板登录失败限速（审计 P1-S2）：按用户名与来源 IP 分别计数，窗口内失败次数超限即拒绝，
 * 不再进入密码校验（scrypt），避免在线爆破与用登录请求占满主线程。只在进程内计数；
 * 来源 IP 取 X-Forwarded-For 首段可被伪造，用户名维度不受影响。
 */
export const LOGIN_WINDOW_MS = 15 * 60_000
export const LOGIN_MAX_FAILURES_PER_USER = 10
export const LOGIN_MAX_FAILURES_PER_IP = 30
const MAX_KEYS = 10_000

export function createLoginThrottle({ now = Date.now } = {}) {
  const failures = new Map()

  const keysOf = (username, ip) => [
    [
      `u:${String(username || '')
        .trim()
        .toLowerCase()}`,
      LOGIN_MAX_FAILURES_PER_USER,
    ],
    [`ip:${String(ip || '')}`, LOGIN_MAX_FAILURES_PER_IP],
  ]

  const live = (key, at) => {
    const entry = failures.get(key)
    if (!entry) return null
    if (at - entry.first >= LOGIN_WINDOW_MS) {
      failures.delete(key)
      return null
    }
    return entry
  }

  const prune = (at) => {
    if (failures.size <= MAX_KEYS) return
    for (const [key, entry] of failures) if (at - entry.first >= LOGIN_WINDOW_MS) failures.delete(key)
  }

  return {
    /** 超限时返回需要等待的毫秒数，否则 0。 */
    retryAfterMs(username, ip) {
      const at = now()
      let wait = 0
      for (const [key, limit] of keysOf(username, ip)) {
        const entry = live(key, at)
        if (entry && entry.count >= limit) wait = Math.max(wait, entry.first + LOGIN_WINDOW_MS - at)
      }
      return wait
    },
    fail(username, ip) {
      const at = now()
      for (const [key] of keysOf(username, ip)) {
        const entry = live(key, at)
        if (entry) entry.count += 1
        else failures.set(key, { count: 1, first: at })
      }
      prune(at)
    },
    succeed(username) {
      failures.delete(keysOf(username, '')[0][0])
    },
  }
}

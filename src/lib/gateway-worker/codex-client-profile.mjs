import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { getDb } from '../db/database.mjs'

// 上游客户端画像与隐私规则（对齐 codex-proxy-rs profile 与 settings/privacy）：控制面保存通用选择、
// 部署配套头与隐私规则，Key 可覆盖画像；Worker 按官方发布资料解析身份并在出站前执行规则。
// 这里的校验与 Worker（worker/internal/codexgateway/profile.go、privacy.go）保持一致，正则在保存时
// 再交给 Worker 预览编译（RE2）确认。

export const DEFAULT_CLIENT_PROFILE = Object.freeze({ client: 'desktop', platform: 'macos', versionMode: 'latest' })
export const CLIENT_PROFILE_SETTING = 'codex_client_profile'
export const PRIVACY_POLICY_SETTING = 'codex_privacy_policy'
export const DEFAULT_PRIVACY_POLICY = Object.freeze({ enabled: false, onError: 'skip_rule', rules: [] })

const MAX_VERSION_LAG = 10
const CLIENTS = ['desktop', 'cli']
const PLATFORMS = ['macos', 'linux', 'windows']
const CLI_ENTRIES = ['tui', 'exec']
const KNOWN_ORIGINATORS = ['Codex Desktop', 'codex-tui', 'codex_exec', 'codex_cli_rs']
const PRIVACY_SCOPES = ['turn_metadata', 'desktop_git_context', 'environment_text', 'request_body', 'request_header']
const PRIVACY_ACTIONS = ['regex_replace', 'set_value', 'rename_key', 'remove_field']

function invalid(code, message) {
  return Object.assign(new TypeError(message), { code })
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function safeField(value, max) {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= max &&
    value.trim() === value &&
    /^[\x20-\x7e]+$/.test(value)
  )
}

const NUMERIC_ID = /^(0|[1-9]\d*)$/
const IDENT = /^[0-9A-Za-z-]+$/

export function validSemver(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false
  const [withPre, build, ...extraBuild] = value.split('+')
  if (extraBuild.length || (build !== undefined && !build.split('.').every((part) => IDENT.test(part)))) return false
  const dash = withPre.indexOf('-')
  const core = dash < 0 ? withPre : withPre.slice(0, dash)
  if (dash >= 0) {
    const pre = withPre.slice(dash + 1).split('.')
    if (!pre.every((part) => IDENT.test(part) && !(/^\d+$/.test(part) && part.length > 1 && part[0] === '0')))
      return false
  }
  const parts = core.split('.')
  return parts.length === 3 && parts.every((part) => NUMERIC_ID.test(part))
}

function numericDotted(value) {
  return typeof value === 'string' && /^\d+(\.\d+)+$/.test(value)
}

function parseCustom(selection) {
  const ua = selection.userAgent
  if (!safeField(ua, 4096))
    throw invalid('invalid_client_profile', '自定义 User-Agent 必须是 1～4096 个可见 ASCII 字符')
  for (const name of KNOWN_ORIGINATORS) {
    if (!ua.startsWith(`${name}/`)) continue
    const version = ua.slice(name.length + 1).split(' ')[0]
    if (!validSemver(version)) throw invalid('invalid_client_profile', 'User-Agent 中的 Core 版本不是有效 SemVer')
    if (
      (selection.originator && selection.originator !== name) ||
      (selection.codexVersion && selection.codexVersion !== version)
    ) {
      throw invalid('invalid_client_profile', '显式 originator 或 Core 版本与 User-Agent 不一致')
    }
    return
  }
  if (!safeField(selection.originator, 128) || !validSemver(selection.codexVersion)) {
    throw invalid('invalid_client_profile', '非官方前缀的 User-Agent 需要同时填写 originator 与 Core 版本')
  }
}

const SELECTION_KEYS = [
  'mode',
  'client',
  'platform',
  'versionMode',
  'versionLag',
  'cliEntry',
  'originator',
  'osType',
  'osVersion',
  'arch',
  'terminal',
  'codexVersion',
  'desktopVersion',
  'desktopBuild',
  'userAgent',
]

/** 规范化并校验画像选择；非法时抛出带 code 的 TypeError。返回只含已知字段的新对象。 */
export function validateClientProfileSelection(raw) {
  if (!isObject(raw)) throw invalid('invalid_client_profile', '画像必须是对象')
  const selection = {}
  for (const key of Object.keys(raw)) {
    if (!SELECTION_KEYS.includes(key)) throw invalid('invalid_client_profile', `未知的画像字段 ${key}`)
    const value = raw[key]
    if (value === '' || value === null || value === undefined) continue
    if (key === 'versionLag') {
      if (!Number.isInteger(value)) throw invalid('invalid_client_profile', 'versionLag 必须是整数')
      if (value !== 0) selection.versionLag = value
      continue
    }
    if (typeof value !== 'string') throw invalid('invalid_client_profile', `${key} 必须是字符串`)
    selection[key] = value
  }
  if (selection.mode === 'custom') {
    parseCustom(selection)
    return {
      mode: 'custom',
      userAgent: selection.userAgent,
      ...(selection.originator ? { originator: selection.originator } : {}),
      ...(selection.codexVersion ? { codexVersion: selection.codexVersion } : {}),
    }
  }
  if (selection.mode !== undefined || !CLIENTS.includes(selection.client) || !PLATFORMS.includes(selection.platform)) {
    throw invalid('invalid_client_profile', '请选择客户端类型与平台')
  }
  if (selection.userAgent) throw invalid('invalid_client_profile', '预设画像不使用自定义 User-Agent')
  if (selection.cliEntry && (selection.client !== 'cli' || !CLI_ENTRIES.includes(selection.cliEntry))) {
    throw invalid('invalid_client_profile', 'CLI 入口只能是 tui 或 exec，且只用于 CLI')
  }
  for (const key of ['originator', 'osType', 'osVersion', 'arch', 'terminal']) {
    if (selection[key] && (!safeField(selection[key], 128) || /[();\\]/.test(selection[key]))) {
      throw invalid('invalid_client_profile', `${key} 包含不允许的字符`)
    }
  }
  if (selection.versionMode === 'latest') {
    if (selection.codexVersion || selection.desktopVersion || selection.desktopBuild) {
      throw invalid('invalid_client_profile', '自动最新版本不填写固定版本')
    }
    const lag = selection.versionLag || 0
    if (lag < 0 || lag > MAX_VERSION_LAG) throw invalid('invalid_client_profile', '滞后版本数为 0～10')
  } else if (selection.versionMode === 'fixed') {
    if (selection.versionLag) throw invalid('invalid_client_profile', '固定版本不使用滞后')
    if (!validSemver(selection.codexVersion)) throw invalid('invalid_client_profile', 'Core 版本必须是有效 SemVer')
    if (selection.client === 'desktop') {
      if (!numericDotted(selection.desktopVersion) || selection.desktopVersion.length > 64) {
        throw invalid('invalid_client_profile', 'Desktop 版本必须是数字点分版本')
      }
      if (!/^\d{1,20}$/.test(selection.desktopBuild || ''))
        throw invalid('invalid_client_profile', 'Desktop 构建号必须是数字')
    }
  } else {
    throw invalid('invalid_client_profile', 'versionMode 必须是 latest 或 fixed')
  }
  if (selection.client === 'cli' && (selection.desktopVersion || selection.desktopBuild)) {
    throw invalid('invalid_client_profile', 'CLI 画像不填写 Desktop 版本')
  }
  return selection
}

export function validateProfileDeployment(raw = {}) {
  if (!isObject(raw)) throw invalid('invalid_profile_deployment', '部署配套头必须是对象')
  const out = {}
  for (const key of ['residency', 'accountRoutingOverride']) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    if (!safeField(value, 256)) throw invalid('invalid_profile_deployment', `${key} 必须是可见 ASCII 字符`)
    out[key] = value
  }
  for (const key of Object.keys(raw)) {
    if (!['residency', 'accountRoutingOverride'].includes(key))
      throw invalid('invalid_profile_deployment', `未知字段 ${key}`)
  }
  return out
}

/** 通用画像设置：{ selection, deployment }；无效或缺失时回退默认。 */
export function readClientProfileSetting(db = null) {
  try {
    const raw = new SettingsRepo(db || getDb()).get(CLIENT_PROFILE_SETTING, null)
    if (!raw) return { selection: { ...DEFAULT_CLIENT_PROFILE }, deployment: {} }
    return {
      selection: validateClientProfileSelection(raw.selection || DEFAULT_CLIENT_PROFILE),
      deployment: validateProfileDeployment(raw.deployment || {}),
    }
  } catch {
    return { selection: { ...DEFAULT_CLIENT_PROFILE }, deployment: {} }
  }
}

// --- 隐私规则 ---

const SELECTOR_KEY = /^[A-Za-z0-9_-]+$/

function validateSelector(source) {
  if (typeof source !== 'string' || source.length > 1024 || !source.startsWith('$')) {
    throw invalid('invalid_privacy_policy', '字段路径应以 $ 开头且不超过 1024 字节')
  }
  let rest = source.slice(1)
  let depth = 0
  while (rest) {
    if (++depth > 16) throw invalid('invalid_privacy_policy', '字段路径最多 16 层')
    if (rest.startsWith('.')) {
      const tail = rest.slice(1)
      const end = tail.search(/[.[]/)
      const key = end < 0 ? tail : tail.slice(0, end)
      if (key !== '*' && !SELECTOR_KEY.test(key))
        throw invalid('invalid_privacy_policy', '成员名包含特殊字符时使用双引号键名')
      rest = end < 0 ? '' : tail.slice(end)
    } else if (rest.startsWith('["')) {
      const match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest)
      if (!match) throw invalid('invalid_privacy_policy', '无效的双引号键名')
      JSON.parse(match[1])
      rest = rest.slice(match[0].length)
    } else if (rest.startsWith('[')) {
      const close = rest.indexOf(']')
      if (close < 0) throw invalid('invalid_privacy_policy', '字段路径缺少 ]')
      const value = rest.slice(1, close)
      if (value !== '*' && !/^\d{1,9}$/.test(value))
        throw invalid('invalid_privacy_policy', '仅支持数组索引和 * 通配，不支持过滤表达式')
      rest = rest.slice(close + 1)
    } else {
      throw invalid('invalid_privacy_policy', '无效的字段路径')
    }
  }
}

/** 结构与上限校验（规则 ≤32、步骤合计 ≤32、路径 ≤16 层、表达式与替换 ≤4096 字节）。 */
export function validatePrivacyPolicy(raw) {
  if (!isObject(raw)) throw invalid('invalid_privacy_policy', '隐私规则必须是对象')
  const onError = raw.onError ?? 'skip_rule'
  if (!['skip_rule', 'reject_request'].includes(onError))
    throw invalid('invalid_privacy_policy', 'onError 必须是 skip_rule 或 reject_request')
  const rules = Array.isArray(raw.rules) ? raw.rules : []
  if (rules.length > 32) throw invalid('invalid_privacy_policy', '最多配置 32 条规则')
  const ids = new Set()
  let total = 0
  const out = []
  for (const [index, rule] of rules.entries()) {
    const where = `第 ${index + 1} 条规则`
    if (!isObject(rule)) throw invalid('invalid_privacy_policy', `${where}必须是对象`)
    const id = String(rule.id ?? '')
    const name = String(rule.name ?? '')
    if (!id || id.length > 64 || !name || name.length > 192)
      throw invalid('invalid_privacy_policy', `${where}：ID 或名称长度不合法`)
    if (ids.has(id)) throw invalid('invalid_privacy_policy', `${where}：规则 ID 重复`)
    ids.add(id)
    const steps = Array.isArray(rule.steps) ? rule.steps : []
    total += steps.length
    if (!steps.length || total > 32)
      throw invalid('invalid_privacy_policy', `${where}：每条规则至少一个步骤，合计最多 32 个`)
    out.push({
      id,
      name,
      enabled: rule.enabled !== false,
      steps: steps.map((step) => {
        if (!isObject(step)) throw invalid('invalid_privacy_policy', `${where}：步骤必须是对象`)
        const { scope, action } = step
        if (!PRIVACY_SCOPES.includes(scope)) throw invalid('invalid_privacy_policy', `${where}：未知的作用范围`)
        if (!PRIVACY_ACTIONS.includes(action)) throw invalid('invalid_privacy_policy', `${where}：未知的处理动作`)
        const selector = String(step.selector ?? '')
        if (scope === 'request_header') {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(selector))
            throw invalid('invalid_privacy_policy', `${where}：请求头名称无效`)
          if (action === 'rename_key') throw invalid('invalid_privacy_policy', `${where}：请求头范围不支持对象键名替换`)
        } else {
          validateSelector(selector)
          if (scope === 'environment_text' && selector !== '$')
            throw invalid('invalid_privacy_policy', `${where}：环境文本使用 $ 选择整个文本值`)
        }
        const pattern =
          step.pattern === undefined || step.pattern === null || step.pattern === '' ? null : String(step.pattern)
        if (pattern && pattern.length > 4096)
          throw invalid('invalid_privacy_policy', `${where}：正则表达式最多 4096 字节`)
        if (pattern && /\(\?<?[=!]|\\[1-9]|\\k</.test(pattern)) {
          throw invalid('invalid_privacy_policy', `${where}：不支持前后顾与模式反向引用`)
        }
        const replacement = String(step.replacement ?? '')
        const value = step.value === undefined ? null : step.value
        if (replacement.length > 4096 || JSON.stringify(value).length > 4096)
          throw invalid('invalid_privacy_policy', `${where}：替换内容最多 4096 字节`)
        if ((action === 'regex_replace' || action === 'rename_key') && !pattern)
          throw invalid('invalid_privacy_policy', `${where}：请填写匹配表达式`)
        if (action === 'set_value' && pattern)
          throw invalid('invalid_privacy_policy', `${where}：固定值动作不使用匹配表达式`)
        return {
          scope,
          selector,
          action,
          pattern,
          replacement,
          value,
          replaceAll: step.replaceAll === true,
          caseInsensitive: step.caseInsensitive === true,
          multiLine: step.multiLine === true,
        }
      }),
    })
  }
  return { enabled: raw.enabled === true, onError, rules: out }
}

export function readPrivacyPolicySetting(db = null) {
  try {
    const raw = new SettingsRepo(db || getDb()).get(PRIVACY_POLICY_SETTING, null)
    return raw ? validatePrivacyPolicy(raw) : { ...DEFAULT_PRIVACY_POLICY, rules: [] }
  } catch {
    return { ...DEFAULT_PRIVACY_POLICY, rules: [] }
  }
}

/** 隐私规则只在启用且至少一条启用规则时随信封下发。 */
export function activePrivacyPolicy(policy) {
  return policy?.enabled && policy.rules.some((rule) => rule.enabled) ? policy : null
}

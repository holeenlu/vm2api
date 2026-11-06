/**
 * ChatGPT 订阅档位（plan_type）的名称与手动覆盖选项。
 * 与 sub2api `features/resources/model/planType.ts` 同一套 SKU 名：prolite / pro / promax 分别是
 * $100 / $200 / $500 的 Pro，不再一律显示成 Pro（上游 vm-status 合并为 Pro，本地按用户要求区分完整档位）。
 * wire 值取自 openai/codex `protocol/src/account.rs`；未知值原样显示。
 */
export const OPENAI_PLAN_TYPES = [
  'free',
  'go',
  'plus',
  'prolite',
  'pro',
  'promax',
  'team',
  'self_serve_business_usage_based',
  'self_serve_business_prolite',
  'business',
  'enterprise',
  'ent26',
  'enterprise_cbp_usage_based',
  'enterprise_cbp_automation',
  'edu',
  'edu_plus',
  'edu_pro',
] as const

/** 比较用的规范键：大小写、空格、下划线、连字符不敏感；chatgptpro 是 pro 的别名。 */
export function openaiPlanKey(value: unknown): string {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return key === 'chatgptpro'
    ? 'pro'
    : key === 'chatgptprolite'
      ? 'prolite'
      : key
}

/** 档位显示名；空值为 GPT（尚未识别），未知值原样返回。 */
export function openaiPlanLabel(planType: unknown): string {
  const raw = String(planType || '').trim()
  switch (openaiPlanKey(raw)) {
    case '':
      return 'GPT'
    case 'free':
    case 'freeworkspace':
    case 'guest':
      return 'Free'
    case 'go':
      return 'Go'
    case 'plus':
      return 'Plus'
    case 'prolite':
      return 'Pro 100'
    case 'pro':
      return 'Pro 200'
    case 'promax':
      return 'Pro 500'
    case 'team':
    case 'selfservebusinessusagebased':
      return 'Business'
    case 'selfservebusinessprolite':
      return 'Business Premium'
    case 'business':
    case 'enterprise':
    case 'ent26':
    case 'enterprisecbpusagebased':
    case 'hc':
      return 'Enterprise'
    case 'enterprisecbpautomation':
      return 'Enterprise (Automation)'
    case 'edu':
    case 'education':
      return 'Edu'
    case 'eduplus':
      return 'Edu Plus'
    case 'edupro':
      return 'Edu Pro'
    case 'unknown':
      return 'Unknown'
    default:
      return raw
  }
}

/** 手动覆盖下拉：首项为清空（自动识别）；当前值与预设同一 SKU 时沿用当前写法，未知当前值追加在末尾。 */
export function openaiPlanOptions(
  current: unknown,
  clearLabel: string
): Array<{ value: string; label: string }> {
  const cur = String(current || '').trim()
  const key = openaiPlanKey(cur)
  const options = [{ value: '', label: clearLabel }]
  for (const preset of OPENAI_PLAN_TYPES) {
    const value = cur && key === openaiPlanKey(preset) ? cur : preset
    options.push({ value, label: openaiPlanLabel(value) })
  }
  if (cur && !options.some((o) => o.value === cur))
    options.push({ value: cur, label: openaiPlanLabel(cur) })
  return options
}

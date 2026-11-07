// The group platform is the authoritative account-platform scope. A mixed
// group can be assigned to both Anthropic and OpenAI accounts; its model
// whitelist still controls which models are routable after assignment.
export function vendorGroupPlatforms(group) {
  const platform = group.platform === 'claude' ? 'anthropic' : group.platform
  return platform === 'mixed' ? ['anthropic', 'openai'] : [platform]
}

const groupList = (value) => {
  try {
    const list = typeof value === 'string' ? JSON.parse(value || '[]') : value
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

/**
 * 供应商的授权分组是否包含该分组（分组与资源管理重整 P3，2026-11-06 统一口径）：
 * 子供应商自己没有配置时继承父级；根供应商没有配置时不允许任何分组；子供应商另外不能超出父级。
 * 此前三处各有口径：运行准入把“为空”当作不限制，Gateway 账号把子供应商“为空”当作没有分组。
 * vendor / parent 是 vendors 表的行（groups_json）或投影（groups）。
 */
export function vendorAllowsGroup(vendor, parent, group) {
  const own = groupList(vendor?.groups_json ?? vendor?.groups)
  const inherited = parent ? groupList(parent.groups_json ?? parent.groups) : []
  const match = (list) => list.includes(String(group.id)) || (group.name != null && list.includes(String(group.name)))
  return match(own.length ? own : inherited) && (!parent || match(inherited))
}

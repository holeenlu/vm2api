import { platformOfModel } from '../admin/price-catalog.mjs'

// A mixed group is eligible only for the model families it actually allows.
// An empty model list has the same unrestricted meaning as the group router.
export function vendorGroupPlatforms(group) {
  const platform = group.platform === 'claude' ? 'anthropic' : group.platform
  const platforms = platform === 'mixed' ? ['anthropic', 'openai'] : [platform]
  const models = group.models || JSON.parse(group.models_json || '[]')
  if (!models.length) return platforms
  const supported = new Set(models.map(platformOfModel).filter(Boolean))
  return platforms.filter((value) => supported.has(value))
}

// The group platform is the authoritative account-platform scope. A mixed
// group can be assigned to both Anthropic and OpenAI accounts; its model
// whitelist still controls which models are routable after assignment.
export function vendorGroupPlatforms(group) {
  const platform = group.platform === 'claude' ? 'anthropic' : group.platform
  return platform === 'mixed' ? ['anthropic', 'openai'] : [platform]
}

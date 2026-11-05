export const SEED_POLICY_FIELDS = Object.freeze([
  'telemetry_disabled',
  'reject_client_settings',
  'reject_client_metadata_identity',
  'theme',
  'extra_env',
  'settings_json_override',
  'claude_setting',
])

export function seedSettingsPatchFromBody(body = {}) {
  const patch = { ...((body && body.seed_policy) || {}) }
  for (const key of SEED_POLICY_FIELDS) if (Object.hasOwn(body, key)) patch[key] = body[key]
  if (Object.hasOwn(body, 'claude.setting')) patch.claude_setting = body['claude.setting']
  return patch
}

import { verifyPassword } from './panel-users.mjs'
import { audit, relayError } from './relay-common.mjs'
import { findOtherUserByEmail } from './repos/panel-users-repo.mjs'

export async function ownProfile(store, id) {
  const user = id && (await store.getById(id))
  if (!user) throw relayError('profile_session_required', '请使用个人账号登录', 403)
  return user
}

export function profileView(user) {
  return {
    username: user.username,
    display_name: user.display_name || '',
    email: user.email?.endsWith('@panel.local') ? '' : user.email || '',
    role: user.role,
    created_at: user.created_at,
  }
}

function onlyFields(input, fields) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw relayError('invalid_profile_fields', '只能修改个人资料字段')
}

export async function updateOwnProfile(store, id, input) {
  onlyFields(input, ['display_name', 'email'])
  const user = await ownProfile(store, id)
  const next = { ...user }
  if (Object.hasOwn(input, 'display_name')) {
    if (
      typeof input.display_name !== 'string' ||
      input.display_name.trim().length > 80 ||
      /[\x00-\x1f\x7f]/.test(input.display_name)
    )
      throw relayError('invalid_display_name', '显示名称需为 80 字以内的文本')
    next.display_name = input.display_name.trim()
  }
  if (Object.hasOwn(input, 'email')) {
    if (typeof input.email !== 'string') throw relayError('invalid_email', '邮箱格式不正确')
    const email = input.email.trim().toLowerCase()
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@panel.local')))
      throw relayError('invalid_email', '邮箱格式不正确')
    next.email = email || `${user.username}@panel.local`
    if (await findOtherUserByEmail(store.db, next.email, id)) throw relayError('email_in_use', '邮箱已被使用', 409)
  }
  next.updated_at = new Date().toISOString()
  const saved = await store.repo.update(next)
  await audit(store.db, user.username, 'profile.update', id, profileView(user), profileView(saved))
  return profileView(saved)
}

export async function changeOwnPassword(store, id, input) {
  onlyFields(input, ['current_password', 'new_password'])
  const user = await ownProfile(store, id)
  if (typeof input.current_password !== 'string' || !(await verifyPassword(input.current_password, user.password_hash)))
    throw relayError('current_password_incorrect', '当前密码不正确', 403)
  if (typeof input.new_password !== 'string' || input.new_password.length < 8 || input.new_password.length > 128)
    throw relayError('invalid_password', '新密码需为 8–128 位')
  await store.update(id, { password: input.new_password }, { actorId: id })
  await audit(store.db, user.username, 'profile.password', id, null, { changed: true })
  return user.username
}

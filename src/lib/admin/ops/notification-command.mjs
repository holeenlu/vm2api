export function notificationStatus(monitor, routingNotify) {
  return monitor?.getStatus?.() || { config: routingNotify, snapshot: null }
}

export function notificationTestConfig(current, body = {}, merge) {
  return merge(current, { email: body.email, telegram: body.telegram, wecom: body.wecom })
}

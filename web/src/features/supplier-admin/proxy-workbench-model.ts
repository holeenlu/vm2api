export function proxyEditPayload(name: string, endpoint: string) {
  const body: { name: string; endpoint?: string } = { name }
  const value = endpoint.trim()
  if (value) body.endpoint = value
  return body
}

/** Secure random bytes are available even on HTTP control panels. */
export function idempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    ''
  )
}

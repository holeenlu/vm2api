import { describe, expect, it } from 'vitest'
import { brandingFaviconHref } from './branding-favicon'

describe('branding favicon addresses', () => {
  it('keeps an HTTP asset address and uses a stable key for saved images', () => {
    const image = 'data:image/png;base64,aGVsbG8='
    const href = brandingFaviconHref('/favicon.ico', image)
    expect(href).toMatch(/^\/favicon\.ico\?v=[0-9a-f]+$/)
    expect(brandingFaviconHref('/favicon.ico', image)).toBe(href)
    expect(href).not.toContain('data:')
  })

  it('changes the address when replacing or removing an image', () => {
    const original = brandingFaviconHref('/favicon.ico', '/logo-v1.png')
    const replacement = brandingFaviconHref('/favicon.ico', '/logo-v2.png')
    const restored = brandingFaviconHref('/favicon.ico', '')
    expect(new Set([original, replacement, restored]).size).toBe(3)
    expect(brandingFaviconHref('/images/favicon_512.png', '/logo-v2.png')).toBe(
      replacement.replace('/favicon.ico', '/images/favicon_512.png')
    )
  })
})

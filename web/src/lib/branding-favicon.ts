export function brandingFaviconHref(path: string, image: string) {
  // A stable cache key, not a security hash. It also works on HTTP installations.
  let revision = 2166136261
  for (let index = 0; index < image.length; index++) {
    revision = Math.imul(revision ^ image.charCodeAt(index), 16777619)
  }
  // Preserve the build's asset revision when adding the saved-brand revision.
  // Empty branding must retain the content-versioned built-in icon URL.
  if (!image) return path
  const url = new URL(path, 'http://site.invalid')
  url.searchParams.set('v', (revision >>> 0).toString(16))
  return `${url.pathname}${url.search}${url.hash}`
}

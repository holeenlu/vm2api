export function brandingFaviconHref(path: string, image: string) {
  // A stable cache key, not a security hash. It also works on HTTP installations.
  let revision = 2166136261
  for (let index = 0; index < image.length; index++) {
    revision = Math.imul(revision ^ image.charCodeAt(index), 16777619)
  }
  return `${path}?v=${(revision >>> 0).toString(16)}`
}

/**
 * Canonical resource projection entry point for panel code.
 *
 * The projection is implemented by the vendor domain because vendor resources
 * are shared by the panel and supplier APIs.  Keeping this adapter in the
 * admin namespace gives panel callers a stable dependency without duplicating
 * secret redaction or resource DTO rules.
 */
export { projectResource } from '../vendor/vendor-platform.mjs'

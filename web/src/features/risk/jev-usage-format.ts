/** Unreported cost uses the caller's localized unknown label. */
export const usageMoney = (nano: number | null, unknown = '-') =>
  nano === null ? unknown : `$${(nano / 1_000_000_000).toFixed(8)}`

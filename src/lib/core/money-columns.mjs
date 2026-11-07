/**
 * 金额列登记表（技术债 M6，盘点见 docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 4.7 节）。
 *
 * - `MONEY_MIRRORS`：有 REAL 镜像的金额列。键是表名，值是 REAL 列名；每列都有整数权威列 `<name>_micros`
 *   （1 美元 / 1 USDT = 1,000,000 微单位）。写入方必须同时写两列（REAL = micros / 1e6），读取与计算只用整数列。
 * - `MONEY_INTEGER_ONLY`：本来就是整数、没有 REAL 镜像的金额列。
 * - `RATIO_COLUMNS`：比例（倍率、汇率、结算单价系数），不是金额，保留 REAL，参与计算时按 ppm 整数换算（money.mjs ratePpm）。
 * - `NON_MONEY_REAL`：其余 REAL 列（百分比、耗时），与金额无关。
 *
 * 守卫测试 test/unit/money-micros-guard.test.mjs 要求新库里每个 REAL 列都在这里归了类，
 * 一致性校验脚本 scripts/audit-money-micros.mjs 按 MONEY_MIRRORS 逐表逐行比对。
 */

export const MONEY_MIRRORS = {
  // 上游表（sub2api 形状）
  usage_logs: [
    'input_cost',
    'output_cost',
    'cache_read_cost',
    'cache_creation_cost',
    'web_search_cost',
    'image_cost',
    'total_cost',
    'actual_cost',
  ],
  api_keys: [
    'quota',
    'quota_used',
    'rate_limit_5h',
    'rate_limit_1d',
    'rate_limit_7d',
    'usage_5h',
    'usage_1d',
    'usage_7d',
  ],
  users: ['balance'],
  redeem_codes: ['value'],
  // 定制表
  groups: ['image_price_1k', 'image_price_2k', 'image_price_4k', 'web_search_price_per_call'],
  vendor_usage_facts: ['cost_usd'],
  vendor_settlements: ['amount_usdt'],
  vendor_payments: ['amount_usdt'],
  usage_cost_hourly: ['input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost', 'total_cost'],
  usage_stats_hourly: ['cost'],
}

export const MONEY_INTEGER_ONLY = {
  admin_domains: ['balance_micros'],
  billing_charges: ['actual_micros'],
  billing_reservations: ['reserved_micros', 'actual_micros'],
  wallet_ledger: ['amount_micros', 'balance_after_micros'],
  groups: ['daily_limit_micros', 'weekly_limit_micros', 'monthly_limit_micros'],
  jev_usage_events: ['estimated_cost_nano_usd', 'input_nano_usd_per_token', 'output_nano_usd_per_token'],
  jev_usage_totals: ['estimated_cost_nano_usd'],
}

/** 比例列：保留 REAL（理由见文档 4.7 节“倍率”），计算时 ratePpm 换成百万分之一整数。 */
export const RATIO_COLUMNS = {
  accounts: ['rate_multiplier'],
  groups: ['rate_multiplier', 'image_rate_multiplier'],
  user_group_overrides: ['rate_multiplier'],
  usage_logs: ['rate_multiplier'],
  billing_charges: ['rate_multiplier'],
  billing_reservations: ['rate_multiplier'],
  vendors: ['default_price_cny_per_usd', 'fx_cny_per_usdt', 'default_multiplier'],
  vendor_contracts: ['price_cny_per_usd', 'fx_cny_per_usdt', 'multiplier'],
}

/** 与金额无关的 REAL 列。 */
export const NON_MONEY_REAL = {
  account_allocations: ['util_5h', 'util_7d'],
  quota_observations: ['used_percent'],
  usage_stats_hourly: ['duration_sum', 'ttft_sum'],
}

/** 有 REAL 镜像的金额列，展开成 `[表, 列]`。 */
export function moneyMirrorPairs() {
  return Object.entries(MONEY_MIRRORS).flatMap(([table, columns]) => columns.map((column) => [table, column]))
}

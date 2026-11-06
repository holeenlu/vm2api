/**
 * 金额整数化（技术债 M6，约定见 docs/DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md 4.7 节）。
 *
 * - 金额的权威值是整数微单位（`*_micros`）：1 美元（或 1 USDT）= 1,000,000 微单位。计算一律在整数上进行；
 *   REAL 列只是展示镜像，由 `fromMicros` 派生，写入时与整数列同时写。
 * - 单价：价格表里的 $/MTok 换成“每百万 token 的微单位”整数（`priceMicros`），token × 单价得到的是精确的
 *   皮单位（1e-12 美元），在最终金额处四舍五入一次（`allocateMicros`）。
 * - 倍率、汇率、结算单价是比例，不是金额：数据库保留 REAL，参与计算时先规范为百万分之一的整数（`ratePpm`）。
 * - 舍入一律四舍五入、远离零（half away from zero），并与 SQLite ROUND 逐位一致（`sqlRound`）；金额大多非负，即“五入”。
 */

export const MICROS_PER_USD = 1_000_000
const M = 1_000_000
const MB = 1_000_000n
const TWO_52 = 4_503_599_627_370_496

/**
 * 金额（微单位）的有效范围：|micros| < 2^51（约 22.5 亿美元）。在这个范围内 `micros / 1e6` 的 REAL 镜像
 * 乘回 1e6 的误差小于 0.5，四舍五入一定得到原值（JS 与 SQLite 同一结果）；2^52 附近（约 42.9 亿美元以上）
 * 会多出 1，所以上限取 2^51 而不是 2^52。超出范围的值不作为金额接受。
 */
export const MAX_MONEY_MICROS = TWO_52 / 2 - 1

/**
 * 与 SQLite `ROUND(x)`（0 位小数）逐位一致的四舍五入：|x| < 2^52 时为 (int64)(x ± 0.5)，否则 x 本身已是整数。
 * JS 回退（`rowMicros`、`toMicros`）与 SQL 回退（`CAST(ROUND(x * 1000000) AS INTEGER)`）因此在任何输入上结果相同，
 * 包括历史 8 位小数 REAL 正好落在 0.5 微单位上的情况（例：1.0000025 × 1e6 = 1000002.4999999999 → 1000002）。
 */
export function sqlRound(x) {
  if (Math.abs(x) >= TWO_52) return x
  return x < 0 ? -Math.trunc(-x + 0.5) || 0 : Math.trunc(x + 0.5)
}

/**
 * 十进制金额（美元、USDT）→ 整数微单位，口径与 SQL `CAST(ROUND(x * 1000000) AS INTEGER)` 相同；
 * null / undefined / '' / 非有限数 / 超出 MAX_MONEY_MICROS → null。
 */
export function toMicros(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const m = sqlRound(n * M)
  if (Math.abs(m) > MAX_MONEY_MICROS) return null
  return m || 0
}

/** 整数微单位 → 十进制金额（只用于展示与对外响应，不再参与计算）；null → null。 */
export function fromMicros(micros) {
  if (micros == null) return null
  const n = Number(micros)
  return Number.isFinite(n) ? n / M : null
}

/** 数据库读出的整数微单位：null 保持 null，其余转为 Number。 */
export function microsOf(value) {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

/** 比例（倍率、汇率、单价系数）→ 百万分之一整数（与 toMicros 同一舍入）；null / 非有限数 → null。最多保留 6 位小数。 */
export function ratePpm(rate) {
  if (rate == null || rate === '') return null
  const n = Number(rate)
  if (!Number.isFinite(n)) return null
  return sqlRound(n * M) || 0
}

/** 整数除法，四舍五入、远离零。a、b 为同类整数（Number 或 BigInt），b > 0。 */
export function roundDiv(a, b) {
  if (typeof a === 'bigint') {
    const d = BigInt(b)
    const q = a / d
    const r = a % d
    const twice = (r < 0n ? -r : r) * 2n
    if (twice >= d) return a < 0n ? q - 1n : q + 1n
    return q
  }
  const r = a % b
  const q = (a - r) / b
  if (Math.abs(r) * 2 >= b) return a < 0 ? q - 1 : q + 1
  return q
}

/** round(a × b / d)，全部为整数；乘积超出安全整数时改用 BigInt，结果仍是 Number。 */
export function mulDivRound(a, b, d) {
  const p = a * b
  if (Number.isSafeInteger(p)) return roundDiv(p, d)
  const out = roundDiv(BigInt(a) * BigInt(b), BigInt(d))
  const n = Number(out)
  if (!Number.isSafeInteger(n)) throw new RangeError('money amount out of range')
  return n
}

/** 金额 × 倍率：`round(micros × ratePpm(rate) / 1e6)`。倍率按存储的整数金额计算，结果可由库内两列复算。 */
export function applyRate(micros, rate) {
  if (micros == null) return null
  const ppm = ratePpm(rate)
  if (ppm == null) return null
  return mulDivRound(micros, ppm, M)
}

/** 价格表单价（$/MTok，或按次、按张的美元单价）→ 整数微单位。 */
export function priceMicros(price) {
  const m = toMicros(price)
  return m == null || m < 0 ? 0 : m
}

/**
 * 皮美元（1e-12 美元，即 1e-6 微单位）精确值：在安全整数范围内用 Number，超出时用 BigInt（热路径上几乎总是 Number）。
 */
function picosOf(n) {
  return Number.isSafeInteger(n) ? n : null
}

/** 两个皮美元精确值相加（Number 或 BigInt）。 */
export function addPicos(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const s = picosOf(a + b)
    if (s != null) return s
  }
  return BigInt(a) + BigInt(b)
}

/** tokens × 单价（每百万 token 的微单位）的精确值，单位为皮美元。 */
export function tokenPicos(tokens, perMTokMicros) {
  if (!tokens || !perMTokMicros) return 0
  const t = Math.trunc(tokens)
  return picosOf(t * perMTokMicros) ?? BigInt(t) * BigInt(perMTokMicros)
}

/** 整数微单位 × 数量 → 皮美元，用于和 token 计价部分一起分摊。 */
export function microsToPicos(micros, count = 1) {
  const m = micros || 0
  const c = Math.trunc(count)
  return picosOf(m * c * M) ?? BigInt(m) * BigInt(c) * MB
}

function allocateBig(parts) {
  const big = parts.map((p) => BigInt(p))
  let sum = 0n
  for (const p of big) sum += p
  const total = roundDiv(sum, MB)
  const out = big.map((p) => p / MB)
  let left = total - out.reduce((a, b) => a + b, 0n)
  if (left > 0n) {
    const order = big.map((p, i) => [p % MB, i]).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] > b[0] ? -1 : 1))
    for (const [, i] of order) {
      if (left <= 0n) break
      out[i] += 1n
      left -= 1n
    }
  }
  const totalN = Number(total)
  if (!Number.isSafeInteger(totalN)) throw new RangeError('money amount out of range')
  return { total: totalN, parts: out.map(Number) }
}

/**
 * 把若干精确部分（皮美元，Number 或 BigInt，非负）一次性舍入到微单位：
 * 总额 = round(Σ部分 / 1e6)，只舍入一次；各部分先向下取整，再按余数从大到小（同余数按顺序）补 1，
 * 使各部分之和恰好等于总额（最大余数法），每个部分与其精确值相差不到 1 微单位。
 */
export function allocateMicros(parts) {
  let sum = 0
  for (const p of parts) {
    if (typeof p !== 'number') return allocateBig(parts)
    sum += p
  }
  if (!Number.isSafeInteger(sum)) return allocateBig(parts)
  const total = roundDiv(sum, M)
  const rem = parts.map((p) => p % M)
  const out = parts.map((p, i) => (p - rem[i]) / M)
  let left = total - out.reduce((a, b) => a + b, 0)
  if (left > 0) {
    const order = rem.map((r, i) => [r, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    for (const [, i] of order) {
      if (left <= 0) break
      out[i] += 1
      left -= 1
    }
  }
  return { total, parts: out }
}

/** 整数微单位求和；任何一项为 null 时按 0 计。 */
export function sumMicros(values) {
  let s = 0
  for (const v of values) s += microsOf(v) || 0
  return s
}

/** SQL 片段：从 REAL 列派生整数微单位（只用于迁移回填、触发器对旧写入方的兜底与一致性校验）。 */
export function microsFromRealSql(column) {
  return `CAST(ROUND(${column} * 1000000) AS INTEGER)`
}

/** 一行的金额（整数微单位）：`<column>_micros` 为权威值；只有它为 NULL 时按 REAL 列派生（与 money-sql.mjs 的 moneySql 同口径）。 */
export function rowMicros(row, column) {
  const micros = microsOf(row?.[column + '_micros'])
  return micros != null ? micros : toMicros(row?.[column])
}

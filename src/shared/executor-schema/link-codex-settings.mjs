/**
 * Codex 本地设置的字段联动（统一控制面重构，R4 审查 P1-1）：控制面保存前与设置页编辑时共用。
 * 被条件隐藏的字段不能让保存失败，所以按联动规则先收敛：
 *   - BPS 默认模板关闭“403 自动停用”时同时关闭“自动恢复”；
 *   - BPS 图片张数上限改小时，提醒余量与压缩预留收敛到上限以内（小于上限）。
 * 只改动这次没被直接编辑的依赖项（与 previous 相同的值）；用户直接设置的矛盾值仍由校验拒绝。返回新对象。
 */
export function linkCodexSettings(next, previous = {}) {
  const out = { ...next }
  const defaults = out.bps_defaults
  if (
    defaults &&
    typeof defaults === 'object' &&
    defaults.auto_disable_on_403 === false &&
    defaults.auto_recover_on_403 &&
    defaults.auto_recover_on_403 === previous?.bps_defaults?.auto_recover_on_403
  )
    out.bps_defaults = { ...defaults, auto_recover_on_403: false }
  const images = out.bps_images
  if (images && typeof images === 'object' && Number.isInteger(images.max_images) && images.max_images >= 1) {
    const ceiling = images.max_images - 1
    const clamped = { ...images }
    for (const key of ['warning_remaining', 'compact_reserve'])
      if (Number.isInteger(clamped[key]) && clamped[key] > ceiling && clamped[key] === previous?.bps_images?.[key])
        clamped[key] = ceiling
    out.bps_images = clamped
  }
  return out
}

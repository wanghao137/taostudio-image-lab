/**
 * Production 4K v2 — Resampler Policy
 *
 * 业务层禁止感知具体数学滤镜（LanczosSharp / Robidoux / ...），只请求质量
 * 档位（auto / faithful / detail）。本模块是唯一的 contentClass → 滤镜路由表。
 *
 * P0 策略：所有 contentClass 统一 EWA LanczosSharp（ImageMagick 官方 resampling
 * 指南对"只想选一个通用滤镜"的推荐：低 jaggies、合理锐度、halo 温和、对斜边
 * 与二维边缘友好）。per-class 差异化路由（text/logo/ui → 低 halo 滤镜候选）是
 * P1 任务，必须由 benchmark-4k-v2 的实测数据决定，不允许凭感觉 hardcode。
 */

/** ImageMagick -filter 取值（固定枚举，业务层不可注入任意字符串） */
export const PRODUCTION_FILTERS = Object.freeze({
  /** 通用生产默认：EWA LanczosSharp */
  lanczosSharp: 'LanczosSharp',
  /** 更锐（halo 更明显），供 detail 档与 benchmark 候选 */
  lanczosRadius: 'LanczosRadius',
  /** 低 halo 候选，text/logo/ui 类 benchmark 候选 */
  robidoux: 'Robidoux',
  /** Mitchell-Netravali，ringing 敏感内容候选 */
  mitchell: 'Mitchell',
})

/** 业务层质量档位（对外语义，非数学滤镜名） */
export const QUALITY_PROFILES = Object.freeze(['auto', 'faithful', 'detail'])

/**
 * 解析生产滤镜。P0：全部走 lanczosSharp；结构上已按 contentClass 分支，
 * benchmark-4k-v2 产出数据后按结论替换各分支（P1-A）。
 */
export function resolveProductionFilter(contentClass = 'photo', profile = 'auto') {
  const normalizedClass = ['text', 'logo', 'ui'].includes(contentClass) ? 'hard-edge' : contentClass
  const normalizedProfile = QUALITY_PROFILES.includes(profile) ? profile : 'auto'
  // P0：统一 EWA LanczosSharp（含 hard-edge 类；待 benchmark 证明低 halo 滤镜更优再分叉）
  void normalizedClass
  void normalizedProfile
  return PRODUCTION_FILTERS.lanczosSharp
}

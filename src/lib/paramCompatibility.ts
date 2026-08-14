import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { getActiveApiProfile } from './apiProfiles'
import { calculateImageSize, normalizeCodexCliImageSize, normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_FAL_OUTPUT_IMAGES = 4
export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(settings: AppSettings) {
  return getActiveApiProfile(settings).provider === 'fal' ? MAX_FAL_OUTPUT_IMAGES : MAX_OPENAI_OUTPUT_IMAGES
}

/**
 * 把「发给 API 的请求尺寸」帽到网关真实渲染能力（1K 档，同比例）。
 * 2026-08-14 探针实测：网关对 4K 提示词/2K size 参数均只返回 1536x1024 原生图——
 * 请求大尺寸买不到额外像素，只换来更大 payload 与超时风险。exact_size 的
 * 4K 目标仍由 task.params.size 保留，本地放大（resizeImageDataUrlToExactSize）
 * 负责到达；这里只收口请求侧。比例保持不变，仅缩放请求底图。
 */
function capRequestSizeToTier(size: string): string {
  const normalized = normalizeImageSize(size)
  if (!normalized || normalized === 'auto') return normalized ?? size
  const match = normalized.match(/^(\d+)x(\d+)$/)
  if (!match) return normalized
  const width = Number(match[1])
  const height = Number(match[2])
  // 已在 1K 档内（含 codexCli 归一化结果）则不动
  if (width * height <= 1_572_864) return normalized
  const ratio = `${width}:${height}`
  return calculateImageSize('1K', ratio) ?? normalized
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean; preserveExactSizeIntent?: boolean; capRequestSize?: boolean } = {},
) {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }
  nextParams.exact_size = nextParams.size !== 'auto' && Boolean(nextParams.exact_size)

  if (activeProfile.provider === 'openai' && activeProfile.codexCli) {
    if (!options.preserveExactSizeIntent || !nextParams.exact_size) {
      nextParams.size = normalizeCodexCliImageSize(nextParams.size)
    }
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  // 非 codexCli 的 openai 兼容路径：exact_size（4K 资产）请求侧收到 1K 档底图。
  // nativeLargeOutput 的服务商（真实支持大尺寸原生输出）可按 profile 跳过收口。
  if (options.capRequestSize && activeProfile.provider === 'openai' && !activeProfile.codexCli && nextParams.exact_size && !activeProfile.nativeLargeOutput) {
    nextParams.size = capRequestSizeToTier(nextParams.size)
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    nextParams.exact_size = nextParams.size !== 'auto' && Boolean(nextParams.exact_size)
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
